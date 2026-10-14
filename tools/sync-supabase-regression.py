#!/usr/bin/env python3
"""Exercise the real exporter and mirror index against a loopback REST test server."""
import importlib.util
import json
import os
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import urlparse

root = Path(__file__).resolve().parents[1]
container = os.environ.get('MIRROR_TEST_CONTAINER')
source = os.environ.get('MIRROR_TEST_SOURCE_DATABASE')
target = os.environ.get('MIRROR_TEST_DATABASE')
assert container == 'volunteer-ux-db'
assert source == 'ux_sync_source_test' and target == 'ux_sync_review_test'
metadata = json.loads(subprocess.check_output(['docker', 'inspect', container]))[0]
assert metadata['Config']['Labels'].get('task') == 'ux-refactor-20261013'
assert metadata['HostConfig']['PortBindings']['5432/tcp'] == [{'HostIp': '127.0.0.1', 'HostPort': '55434'}]
spec = importlib.util.spec_from_file_location('volunteer_sync', root / 'scripts/sync-supabase-database.py')
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)
native_popen = subprocess.Popen
checks, requests = [], []
fail_retired = False

def sql(database, statement):
    assert database in (source, target)
    return subprocess.run(['docker', 'exec', '-i', container, 'psql', '-U', 'ux_test', '-d', database,
        '-q', '-t', '-A', '-v', 'ON_ERROR_STOP=1'], input=statement, text=True, capture_output=True)

def value(database, statement):
    result = sql(database, statement)
    assert result.returncode == 0, result.stderr
    return result.stdout.strip()

def quoted(value):
    return "'" + value.replace("'", "''") + "'"

def export_transport(arguments, **kwargs):
    # Keep export_rows' actual SQL; only adapt Docker Compose to the labelled test container.
    if arguments[:3] == ['docker', 'compose', 'exec']:
        assert arguments[arguments.index('-d') + 1] == source
        arguments = ['docker', 'exec', '-i', container, 'psql', '-U', 'ux_test', '-d', source,
                     '-q', '-t', '-A', '-c', arguments[-1]]
    return native_popen(arguments, **kwargs)

class Mirror(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        table = urlparse(self.path).path.rsplit('/', 1)[-1]
        assert table in ('import_batches', 'volunteer_logs')
        assert self.headers['apikey'] == 'synthetic-mirror-key'
        rows = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        requests.append({'table': table, 'rows': rows})
        if fail_retired and table == 'import_batches' and any(row['superseded_at'] for row in rows):
            self.send_response(503); self.end_headers(); return
        columns = list(rows[0])
        assert all(column.replace('_', '').isalnum() for column in columns)
        projection = ','.join('"' + column + '"' for column in columns)
        updates = ','.join('"' + column + '"=EXCLUDED."' + column + '"' for column in columns if column != 'id')
        # Deliberately reorder a bulk POST: retired and active phases must be separate requests.
        result = sql(target, f'INSERT INTO public.{table}({projection}) SELECT {projection} FROM '
            f'json_populate_recordset(NULL::public.{table},{quoted(json.dumps(rows))}::json) ORDER BY id '
            f'ON CONFLICT(id) DO UPDATE SET {updates};')
        self.send_response(201 if result.returncode == 0 else 409)
        self.end_headers()
        if result.returncode: self.wfile.write(result.stderr.encode())

server = ThreadingHTTPServer(('127.0.0.1', 0), Mirror)
thread = threading.Thread(target=server.serve_forever, daemon=True)
thread.start()
endpoint = 'http://127.0.0.1:' + str(server.server_port)

def fixture(pairs=1, existing=True):
    requests.clear()
    for database in (source, target): value(database, 'TRUNCATE import_batches CASCADE;')
    for index in range(1, pairs + 1):
        old = f'ffffffff-ffff-4fff-8fff-{index:012d}'
        new = f'00000000-0000-4000-8000-{index:012d}'
        digest = str(index) * 64
        common = f"'合成镜像文件-{index}',{quoted(digest)},'mirror-{index}',1"
        value(source, 'INSERT INTO import_batches(id,filename,file_hash,dataset_key,record_count,superseded_at) VALUES '
              f"('{old}',{common},'2026-10-14T00:00:00Z'),('{new}',{common},NULL);")
        if existing: value(target, 'INSERT INTO import_batches(id,filename,file_hash,dataset_key,record_count,superseded_at) VALUES '
                           f"('{old}',{common},NULL);")
        value(source, 'INSERT INTO volunteer_logs(student_id,student_name,activity_name,activity_date,hours,source,status,import_batch_id) '
              f"VALUES('SYNC-REVIEW-{index}','合成镜像学生','合成同步活动','2026-10-14',2.5,'imported','approved','{new}');")

def upload(table, size):
    with patch.object(sync.subprocess, 'Popen', side_effect=export_transport):
        return sync.sync_table(root, 'test-only', source, 'ux_test', endpoint, 'synthetic-mirror-key', table, 'id', size)

def assert_mirror(pairs, size):
    upload('import_batches', size)
    batches = [request['rows'] for request in requests if request['table'] == 'import_batches']
    active_started = False
    for batch in batches:
        statuses = {row['superseded_at'] is None for row in batch}
        assert len(statuses) == 1, 'retired and active batches shared one bulk request'
        active = statuses.pop()
        assert active or not active_started, 'a retired batch was sent after an active batch'
        active_started = active_started or active
    assert value(target, 'SELECT count(*) FROM import_batches WHERE superseded_at IS NULL') == str(pairs)
    assert value(target, 'SELECT count(*) FROM import_batches WHERE superseded_at IS NOT NULL') == str(pairs)
    upload('volunteer_logs', size)
    assert value(target, 'SELECT count(*) FROM volunteer_logs') == str(pairs)

def check(name, action):
    try:
        action(); checks.append({'name': name, 'passed': True})
    except (Exception, SystemExit) as error:
        checks.append({'name': name, 'passed': False, 'error': str(error)[:1000]})
    print(('PASS ' if checks[-1]['passed'] else 'FAIL ') + name, flush=True)

def replacement(size, pairs=1):
    fixture(pairs); assert_mirror(pairs, size)

def initial_and_repeat():
    fixture(existing=False)
    for _ in range(2):
        requests.clear()
        upload('import_batches', 2000); upload('volunteer_logs', 2000)
        assert value(target, 'SELECT count(*) FROM import_batches') == '2'
        assert value(target, 'SELECT count(*) FROM import_batches WHERE superseded_at IS NULL') == '1'
        assert value(target, 'SELECT count(*) FROM volunteer_logs') == '1'

def stop_on_retirement_failure():
    global fail_retired
    fixture(); fail_retired = True
    try:
        try: upload('import_batches', 1)
        except SystemExit: pass
        else: raise AssertionError('retirement failure did not stop synchronization')
        assert requests and all(row['superseded_at'] is not None for request in requests for row in request['rows'])
        assert value(target, 'SELECT count(*) FROM import_batches WHERE superseded_at IS NULL') == '1'
    finally: fail_retired = False
    requests.clear(); assert_mirror(1, 1)

try:
    check('same-hash replacement retires the mirrored batch before the earlier new UUID (page size 1)', lambda: replacement(1))
    check('retired and active batches remain separate even within one large page', lambda: replacement(2000))
    check('multiple replacements preserve retired-first order across page boundaries', lambda: replacement(2, 3))
    check('initial mirror and repeated sync preserve histories and downstream records', initial_and_repeat)
    check('retirement upload failure blocks active uploads and a retry recovers', stop_on_retirement_failure)
finally:
    server.shutdown(); server.server_close(); thread.join()
    Path(os.environ.get('MIRROR_RESULT_PATH', '/tmp/ux-mirror-result.json')).write_text(json.dumps(checks, ensure_ascii=False, indent=2))
raise SystemExit(any(not check['passed'] for check in checks))
