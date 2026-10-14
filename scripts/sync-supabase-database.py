#!/usr/bin/env python3
import argparse
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


TABLES = [
    ("users", "id"),
    ("schema_migrations", "version"),
    ("public_counters", "name"),
    ("activities", "id"),
    ("import_batches", "id"),
    ("operation_logs", "id"),
    ("volunteer_logs", "id"),
    ("publication_batches", "id"),
    ("publication_state", "id"),
    ("review_notes", "id"),
]


def load_env_file(path):
    if not path.exists():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip("'").strip('"')
        os.environ.setdefault(key, value)


def require_env(name):
    value = os.environ.get(name)
    if not value:
        raise SystemExit(f"Missing required environment variable: {name}")
    return value


def auth_headers(service_key):
    headers = {"apikey": service_key, "User-Agent": "VolunteerSync/1.0"}
    if not service_key.startswith("sb_secret_"):
        headers["Authorization"] = f"Bearer {service_key}"
    return headers


def supabase_request(method, supabase_url, service_key, table, payload=None, params=None):
    endpoint = f"{supabase_url.rstrip('/')}/rest/v1/{table}"
    if params:
        endpoint += "?" + urllib.parse.urlencode(params)
    data = None if payload is None else json.dumps(payload, ensure_ascii=False, default=str).encode("utf-8")
    req = urllib.request.Request(
        endpoint,
        data=data,
        method=method,
        headers={
            **auth_headers(service_key),
            "Content-Type": "application/json",
            "Prefer": "resolution=merge-duplicates,return=minimal",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as response:
            response.read()
            return response.status
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")
        raise SystemExit(f"Supabase {method} {table} failed: HTTP {exc.code} {body}") from exc


def export_rows(compose_dir, service, db_name, db_user, table):
    projection = "*, md5(snapshot::text) AS snapshot_md5" if table == "publication_batches" else "*"
    order = "(superseded_at IS NULL), id" if table == "import_batches" else "1"
    sql = f"SELECT row_to_json(t)::text FROM (SELECT {projection} FROM public.{table} ORDER BY {order}) t;"
    return subprocess.Popen(
        [
            "docker",
            "compose",
            "exec",
            "-T",
            service,
            "psql",
            "-U",
            db_user,
            "-d",
            db_name,
            "-q",
            "-t",
            "-A",
            "-c",
            sql,
        ],
        cwd=compose_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
    )


def sync_table(compose_dir, service, db_name, db_user, supabase_url, service_key, table, primary_key, batch_size):
    if table == 'publication_batches':
        return sync_publications(compose_dir, service, db_name, db_user, supabase_url, service_key)
    process = export_rows(compose_dir, service, db_name, db_user, table)
    total = 0
    batches = 0
    batch = []

    assert process.stdout is not None
    for line_number, raw in enumerate(process.stdout, start=1):
        line = raw.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            process.kill()
            raise SystemExit(f"Invalid JSON from {table} line {line_number}: {exc}") from exc
        # Release mirrored current-hash entries before any active batch is uploaded, even within one page.
        if table == "import_batches" and batch and batch[-1].get("superseded_at") is not None and row.get("superseded_at") is None:
            supabase_request("POST", supabase_url, service_key, table, batch, {"on_conflict": primary_key})
            total += len(batch)
            batches += 1
            batch = []
        batch.append(row)
        if len(batch) >= batch_size:
            supabase_request("POST", supabase_url, service_key, table, batch, {"on_conflict": primary_key})
            total += len(batch)
            batches += 1
            batch = []

    if batch:
        supabase_request("POST", supabase_url, service_key, table, batch, {"on_conflict": primary_key})
        total += len(batch)
        batches += 1

    stderr = process.stderr.read() if process.stderr else ""
    code = process.wait()
    if code != 0:
        raise SystemExit(f"Export {table} failed with exit {code}: {stderr}")

    return {"table": table, "rows": total, "batches": batches}


def publication_rpc(supabase_url, service_key, payload):
    req = urllib.request.Request(
        supabase_url.rstrip('/') + '/rest/v1/rpc/sync_publication_snapshot',
        data=json.dumps(payload, ensure_ascii=False).encode('utf-8'), method='POST',
        headers={**auth_headers(service_key), 'Content-Type': 'application/json'},
    )
    with urllib.request.urlopen(req, timeout=90) as response:
        return json.loads(response.read())


def sync_publications(compose_dir, service, db_name, db_user, supabase_url, service_key):
    endpoint = supabase_url.rstrip('/') + '/rest/v1/publication_batches?' + urllib.parse.urlencode({'select': 'id,uploading:snapshot->>_uploading'})
    with urllib.request.urlopen(urllib.request.Request(endpoint, headers=auth_headers(service_key)), timeout=30) as response:
        existing = {row['id'] for row in json.loads(response.read()) if row.get('uploading') != 'true'}
    process = export_rows(compose_dir, service, db_name, db_user, 'publication_batches')
    total = skipped = uploaded = chunks = 0
    assert process.stdout is not None
    try:
        for raw in process.stdout:
            if not raw.strip(): continue
            row = json.loads(raw); total += 1
            if row['id'] in existing:
                # Frozen versions are immutable; avoid rewriting previously verified large snapshots.
                skipped += 1
                continue
            digest = row.pop('snapshot_md5')
            snapshot = row.pop('snapshot')
            publication_rpc(supabase_url, service_key, {'p_id':row['id'], 'p_operation':'begin', 'p_metadata':{**row, 'rules':snapshot['rules']}})
            for field in ['records', 'totals']:
                batch = []; size = 2
                for record in snapshot[field]:
                    record_size = len(json.dumps(record, ensure_ascii=False).encode('utf-8')) + 2
                    if batch and (size + record_size > 700000 or len(batch) >= 1000):
                        publication_rpc(supabase_url, service_key, {'p_id':row['id'], 'p_operation':'append', 'p_field':field, 'p_chunk':batch})
                        chunks += 1; batch = []; size = 2
                    batch.append(record); size += record_size
                if batch:
                    publication_rpc(supabase_url, service_key, {'p_id':row['id'], 'p_operation':'append', 'p_field':field, 'p_chunk':batch})
                    chunks += 1
            # ponytail: appends rewrite JSONB; use Storage for frozen snapshots if this 34k-row monthly library grows substantially.
            proof = publication_rpc(supabase_url, service_key, {'p_id':row['id'], 'p_operation':'finish', 'p_digest':digest})
            if proof.get('digest') != digest or proof.get('records') != row['record_count'] or proof.get('uploading'):
                raise RuntimeError('publication mirror verification failed')
            uploaded += 1
        error = process.stderr.read() if process.stderr else ''
        if process.wait() != 0:
            raise RuntimeError('publication export failed')
    except BaseException:
        process.kill(); process.wait()
        raise
    return {'table':'publication_batches','rows':total,'batches':chunks,'uploaded_versions':uploaded,'existing_versions':skipped}


def clear_table(supabase_url, service_key, table, primary_key):
    supabase_request(
        "DELETE",
        supabase_url,
        service_key,
        table,
        params={primary_key: "not.is.null"},
    )
    return {"table": table, "cleared": True}


def main():
    parser = argparse.ArgumentParser(description="Mirror local volunteer-system Postgres rows into Supabase Database.")
    parser.add_argument("--compose-dir", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--service", default=os.environ.get("POSTGRES_SERVICE", "postgres"))
    parser.add_argument("--db", default=os.environ.get("POSTGRES_DB", "volunteer_db"))
    parser.add_argument("--db-user", default=os.environ.get("POSTGRES_USER", "postgres"))
    parser.add_argument("--batch-size", type=int, default=int(os.environ.get("SUPABASE_DB_SYNC_BATCH_SIZE", "2000")))
    parser.add_argument("--replace", action="store_true", help="Delete mirrored Supabase rows before uploading local rows.")
    args = parser.parse_args()

    compose_dir = Path(args.compose_dir).resolve()
    load_env_file(compose_dir / ".env")
    load_env_file(compose_dir / ".supabase-backup.env")

    supabase_url = require_env("SUPABASE_URL")
    service_key = require_env("SUPABASE_SERVICE_ROLE_KEY")

    cleared = []
    if args.replace:
        cleared = [
            clear_table(supabase_url, service_key, table, primary_key)
            for table, primary_key in reversed(TABLES)
        ]

    results = [
        sync_table(
            compose_dir,
            args.service,
            args.db,
            args.db_user,
            supabase_url,
            service_key,
            table,
            primary_key,
            args.batch_size,
        )
        for table, primary_key in TABLES
    ]

    print(json.dumps({"cleared": cleared, "synced": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
