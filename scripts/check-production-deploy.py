#!/usr/bin/env python3
"""Exercise deployment failure boundaries using temporary Git repos and fake services.

Uses real Git, Bash, tar and OpenSSL; never calls the host's Docker daemon.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
FAKE_TOOL = r'''#!/usr/bin/env python3
import json, os, shutil, sys
from pathlib import Path
tool = Path(sys.argv[0]).name
args = sys.argv[1:]
state_path = Path(os.environ['FIXTURE_STATE'])
state = json.loads(state_path.read_text())
state['events'].append([tool, *args])
def save(): state_path.write_text(json.dumps(state))
save()
failure = os.environ.get('FIXTURE_FAILURE', '')
if tool == 'npm':
    prefix = Path(args[args.index('--prefix') + 1])
    if 'build' in args:
        if failure == 'build': sys.exit(1)
        (prefix / 'dist').mkdir(exist_ok=True)
        (prefix / 'dist/index.html').write_text('new frontend')
elif tool == 'docker':
    if args[0] == 'run' and failure == 'test': sys.exit(1)
    elif args[0] == 'inspect': print(state['live'])
    elif args[:2] == ['image', 'inspect']: print('new-image')
    elif args[:2] == ['image', 'tag']:
        state['tag'] = 'old-image' if args[2] == 'old-image' else 'new-image'
        save()
    elif args[0] == 'compose' and 'backend' in args:
        state['live'] = state['tag']
        save()
        if failure == 'restart' and state['live'] == 'new-image': sys.exit(1)
    elif args[0] == 'exec' and 'pg_dump' in args:
        if failure == 'backup': sys.exit(1)
        sys.stdout.buffer.write(b'PGDMP fixture database')
    elif args[0] == 'exec' and 'pg_restore' in args:
        assert '--file=/dev/null' in args, 'Database restoration must never be automatic'
        assert sys.stdin.buffer.read().startswith(b'PGDMP')
        print('verified fixture dump')
elif tool == 'curl':
    if failure == 'health' and state['live'] == 'new-image': sys.exit(22)
    print('{"status":"ok"}')
elif tool == 'rsync':
    shutil.copytree(args[-2], args[-1], dirs_exist_ok=True)
'''


def run(*args, cwd=None, env=None, check=True):
    return subprocess.run(args, cwd=cwd, env=env, check=check,
                          text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)


def scenario(name, failure='', dirty=False, untracked=False, stale=False):
    with tempfile.TemporaryDirectory(prefix='volunteer-deploy-check-') as temp:
        root = Path(temp)
        app = root / 'app'
        app.mkdir()
        for directory in ('backend', 'frontend-query', 'frontend-admin', 'frontend-status',
                          'nginx', 'scripts', 'deploy', 'tools'):
            (app / directory).mkdir()
            (app / directory / 'version').write_text('old')
        for frontend in ('frontend-query', 'frontend-admin'):
            (app / frontend / 'dist').mkdir()
            (app / frontend / 'dist/index.html').write_text('old frontend')
        (app / 'README.md').write_text('original documentation')
        (app / '.gitignore').write_text('.env\n**/dist/\n.release-version.json\n')
        for filename in ('docker-compose.yml', 'docker-compose.override.yml'):
            (app / filename).write_text('services: {}\n')
        run('git', 'init', '-b', 'main', cwd=app)
        run('git', 'config', 'user.email', 'fixture@example.invalid', cwd=app)
        run('git', 'config', 'user.name', 'Deployment fixture', cwd=app)
        run('git', 'add', '.', cwd=app)
        run('git', 'commit', '-m', 'before', cwd=app)
        before = run('git', 'rev-parse', 'HEAD', cwd=app).stdout.strip()
        (app / 'backend/version').write_text('new')
        run('git', 'commit', '-am', 'candidate', cwd=app)
        candidate = run('git', 'rev-parse', 'HEAD', cwd=app).stdout.strip()
        run('git', 'update-ref', 'refs/remotes/origin/main', candidate, cwd=app)
        run('git', 'reset', '--merge', before, cwd=app)
        (app / 'README.md').write_text('uncommitted documentation must survive')
        (app / '.env').write_text('DB_PASSWORD=fixture-only-secret\n')
        os.chmod(app / '.env', 0o600)
        previous_metadata = json.dumps({'commit': before})
        (app / '.release-version.json').write_text(previous_metadata)
        if dirty:
            (app / 'backend/version').write_text('uncommitted code')
        if untracked:
            (app / 'backend/untracked.js').write_text('uncommitted new code')
        tools_dir = root / 'bin'
        tools_dir.mkdir()
        for tool in ('docker', 'npm', 'curl', 'rsync', 'sleep'):
            path = tools_dir / tool
            path.write_text(FAKE_TOOL)
            path.chmod(0o755)
        state_path = root / 'state.json'
        state_path.write_text(json.dumps(dict(live='old-image', tag='old-image', events=[])))
        env = dict(os.environ, PATH=str(tools_dir) + os.pathsep + os.environ['PATH'],
                   APP_DIR=str(app), RELEASES_DIR=str(root / 'releases'),
                   FIXTURE_STATE=str(state_path), FIXTURE_FAILURE=failure,
                   BASE_URL='http://fixture.invalid', PUBLIC_URL='https://fixture.invalid')
        result = run('bash', str(ROOT / 'scripts/deploy-production.sh'),
                     before if stale else candidate, env=env, check=False)
        expected_success = not (failure or dirty or untracked or stale)
        assert (result.returncode == 0) == expected_success, (name, result.stdout)
        state = json.loads(state_path.read_text())
        assert (app / '.env').read_text() == 'DB_PASSWORD=fixture-only-secret\n'
        assert (app / 'README.md').read_text() == 'uncommitted documentation must survive'
        assert 'fixture-only-secret' not in result.stdout
        assert run('git', 'rev-parse', 'HEAD', cwd=app).stdout.strip() == (
            candidate if expected_success else before), (name, result.stdout)
        assert state['live'] == ('new-image' if expected_success else 'old-image')
        if not expected_success:
            assert (app / '.release-version.json').read_text() == previous_metadata
            assert (app / 'frontend-query/dist/index.html').read_text() == 'old frontend'
        else:
            assert json.loads((app / '.release-version.json').read_text())['commit'] == candidate
            assert (app / 'frontend-query/dist/index.html').read_text() == 'new frontend'
        if dirty or untracked or stale:
            assert not state['events'], 'Preflight rejection must precede builds or service calls'
        if failure in ('build', 'test', 'backup'):
            assert not any(event[:2] == ['docker', 'compose'] for event in state['events'])
        if failure in ('restart', 'health'):
            assert 'Previous code and image restored' in result.stdout, result.stdout
        for encrypted in (root / 'releases').glob('*/database.dump.enc'):
            if encrypted.stat().st_size:
                assert encrypted.read_bytes().startswith(b'Salted__')
                assert (encrypted.stat().st_mode & 0o077) == 0
        print('PASS:', name)


for command in ('', 'bash', 'deploy main', 'deploy ' + 'a' * 40 + '; id'):
    result = run('bash', str(ROOT / 'deploy/github-deploy-command.sh'),
                 env=dict(os.environ, SSH_ORIGINAL_COMMAND=command), check=False)
    assert result.returncode == 64, result.stdout
print('PASS: restricted SSH rejects shell commands and malformed revisions')
scenario('successful deployment preserves dirty documentation and credentials')
scenario('failed frontend build leaves production untouched', failure='build')
scenario('failed container regression tests leave production untouched', failure='test')
scenario('failed database backup leaves production untouched', failure='backup')
scenario('failed service switch restores code, image and frontend', failure='restart')
scenario('failed health checks restore code, image and frontend', failure='health')
scenario('dirty runtime source blocks deployment', dirty=True)
scenario('untracked runtime source blocks deployment', untracked=True)
scenario('stale revision blocks deployment', stale=True)
