"""Real-daemon fault observations for the e2e owner; trusted Docker lane only."""
import importlib.util
import json
import os
from pathlib import Path
import selectors
import shutil
import signal
import subprocess
import sys
import tempfile
import time


def birth(pid):
    try:
        text = Path('/proc/%d/stat' % pid).read_text()
    except FileNotFoundError:
        return None
    fields = text[text.rfind(')') + 2:].split()
    return fields[19], fields[0]


def absent(pid, identity):
    current = birth(pid)
    return current is None or current[0] != identity or current[1] in ('Z', 'X', 'x')


def children(pid):
    return [int(value) for value in Path('/proc/%d/task/%d/children' % (pid, pid)).read_text().split()]


def worker(mode, owned):
    repository = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location('e2e_owner', repository / 'scripts/e2e-engine-supervisor.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    original_spawn = module.subprocess.Popen
    original_info = module.engine_info
    original_mkdtemp = module.tempfile.mkdtemp
    original_open = module.Path.open
    original_access = module.os.access

    def open_path(path, *args, **kwargs):
        if mode == 'setup' and path.name == 'daemon.log':
            raise PermissionError('injected owned log creation failure')
        return original_open(path, *args, **kwargs)

    def executable(path, permission):
        return False if mode == 'executable' and path == '/usr/bin/containerd' else original_access(path, permission)

    def create_root(*args, **kwargs):
        return original_mkdtemp(*args, **kwargs, dir=owned)

    def observed_info(path):
        info = original_info(path)
        if mode == 'identity':
            info['DockerRootDir'] = '/not-the-owned-root'
        return info

    def external_process(args, **kwargs):
        if args[0] == '/usr/bin/dockerd' and mode == 'partial':
            args = ['/usr/bin/python3', '-c', 'raise SystemExit(17)']
        elif args[0] == '/usr/bin/bash':
            # Only the external scenario is held; both daemons and identity reads stay real.
            args = ['/usr/bin/sleep', '300']
            child = original_spawn(args, **kwargs)
            print('scenario-ready', flush=True)
            return child
        return original_spawn(args, **kwargs)

    module.tempfile.mkdtemp = create_root
    module.engine_info = observed_info
    module.subprocess.Popen = external_process
    module.Path.open = open_path
    module.os.access = executable
    sys.argv = [str(repository / 'scripts/e2e-engine-supervisor.py'), os.environ['SUDO_UID'],
                os.environ['SUDO_GID'], '/usr/bin:/bin', '/home/ubuntu']
    try:
        module.main()
    except Exception:
        raise SystemExit(1)


def parent(mode):
    if os.getuid() != 0 or int(os.environ['SUDO_UID']) <= 0:
        raise RuntimeError('Trusted nonroot sudo invocation required')
    owned = Path(tempfile.mkdtemp(prefix='dsh-team-e2e-fixture-'))
    sentinel = subprocess.Popen(['/usr/bin/sleep', '300'])
    child = None
    captured = []
    success = False
    try:
        worker_args = ['/usr/bin/python3', str(Path(__file__).resolve()), 'worker', mode, str(owned)]
        args = ['/usr/bin/unshare', '--fork', '--pid', '--mount-proc',
                '--propagation', 'private', '--kill-child=SIGKILL', *worker_args]
        if mode == 'prerequisite':
            args = worker_args
        elif mode == 'parent-kill':
            # A separate producer owns the sole write end, just like the public Node entry.
            producer = 'import subprocess,sys,json; child=subprocess.Popen(json.loads(sys.argv[1]),stdin=subprocess.PIPE); child.wait()'
            args = ['/usr/bin/python3', '-c', producer, json.dumps(args)]
        child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, text=True)
        if mode in ('eof', 'supervisor-kill', 'parent-kill'):
            selector = selectors.DefaultSelector()
            selector.register(child.stdout, selectors.EVENT_READ)
            try:
                if not selector.select(30) or child.stdout.readline().strip() != 'scenario-ready':
                    raise RuntimeError('Real private scenario did not reach hold')
            finally:
                selector.close()
            roots = children(child.pid)
            if len(roots) != 1:
                raise RuntimeError('Owned namespace identity unavailable')
            supervisor = children(roots[0])[0] if mode == 'parent-kill' else roots[0]
            descendants = children(supervisor)
            if len(descendants) != 3:
                raise RuntimeError('Expected both real daemons and held scenario')
            captured = [(pid, birth(pid)[0]) for pid in [supervisor, *descendants]]
            if os.readlink('/proc/%d/ns/pid' % supervisor) == os.readlink('/proc/self/ns/pid'):
                raise RuntimeError('Supervisor shares host PID namespace')
            if mode == 'eof':
                child.stdin.close()
            elif mode == 'parent-kill':
                child.kill()
            else:
                if birth(supervisor)[0] != captured[0][1]:
                    raise RuntimeError('Supervisor identity changed')
                os.kill(supervisor, signal.SIGKILL)
        code = child.wait(timeout=45)
        if code == 0:
            raise RuntimeError('Fault incorrectly reported success')
        deadline = time.monotonic() + 45
        while not all(absent(pid, identity) for pid, identity in captured) and time.monotonic() < deadline:
            time.sleep(.05)
        if mode in ('partial', 'identity', 'prerequisite', 'executable', 'setup') and 'scenario-ready' in child.stdout.read():
            raise RuntimeError('Scenario admitted despite failed isolation')
        if not all(absent(pid, identity) for pid, identity in captured):
            raise RuntimeError('Private process retained')
        if mode != 'supervisor-kill' and list(owned.iterdir()):
            raise RuntimeError('Graceful fault cleanup retained private roots')
        if sentinel.poll() is not None:
            raise RuntimeError('Unrelated sentinel was retired')
        success = True
        print(json.dumps({'mode': mode, 'faultRejected': True, 'ownedTreeGone': True,
                          'unrelatedSentinelAlive': True, 'gracefulRootsRemoved': mode != 'supervisor-kill'}))
    finally:
        if child is not None and child.poll() is None:
            child.stdin.close()
            child.wait(timeout=45)
        sentinel.terminate()
        sentinel.wait(timeout=5)
        if success:
            # The parent created this exact root before worker admission. A killed PID1
            # has settled its mount namespace and children before this rescue removes it.
            shutil.rmtree(owned)
        else:
            print('e2e fault fixture retained ' + str(owned), file=sys.stderr)


def public_group(caller_path):
    import pwd
    import shlex
    uid, gid = int(os.environ['SUDO_UID']), int(os.environ['SUDO_GID'])
    if os.getuid() != 0 or uid <= 0:
        raise RuntimeError('Trusted nonroot sudo invocation required')
    repository = Path(__file__).resolve().parents[2]
    owned = Path(tempfile.mkdtemp(prefix='dsh-team-e2e-fixture-'))
    os.chown(owned, uid, gid)
    real_hurl = shutil.which('hurl', path=caller_path)
    pnpm = shutil.which('pnpm', path=caller_path)
    if real_hurl is None or pnpm is None:
        raise RuntimeError('Public cancellation prerequisites unavailable')
    marker = owned / 'http-complete'
    shim = owned / 'hurl'
    shim.write_text('#!/bin/sh\n' + shlex.quote(real_hurl) + ' "$@" || exit $?\n' +
                    'touch ' + shlex.quote(str(marker)) + '\nexec /usr/bin/sleep 300\n')
    shim.chmod(0o700)
    os.chown(shim, uid, gid)
    child = None
    captured = []
    engine_root = None
    sentinel = subprocess.Popen(['/usr/bin/sleep', '300'])
    try:
        child = subprocess.Popen([pnpm, 'run', 'e2e'], cwd=repository, user=uid, group=gid,
            extra_groups=[], start_new_session=True, stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            env={'PATH': str(owned) + ':' + caller_path, 'HOME': pwd.getpwuid(uid).pw_dir, 'LANG': 'C.UTF-8'})
        deadline = time.monotonic() + 40
        while not marker.exists():
            if child.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError('Actual public e2e did not complete HTTP before hold')
            time.sleep(.05)
        pending = [child.pid]
        engine_roots = []
        while pending:
            pid = pending.pop()
            identity = birth(pid)
            if identity is None:
                continue
            captured.append((pid, identity[0]))
            pending.extend(children(pid))
            args = (Path('/proc') / str(pid) / 'cmdline').read_bytes().split(b'\0')
            if args[0] == b'/usr/bin/dockerd':
                path = Path(os.fsdecode(args[args.index(b'--data-root') + 1])).parent
                if path.parent != Path('/tmp') or not path.name.startswith('dsh-team-e2e-engine-'):
                    raise RuntimeError('Owned daemon root mismatch')
                engine_roots.append(path)
        if len(engine_roots) != 1:
            raise RuntimeError('Actual private daemon not observed')
        engine_root = engine_roots[0]
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=45)
        deadline = time.monotonic() + 45
        while not all(absent(pid, identity) for pid, identity in captured) and time.monotonic() < deadline:
            time.sleep(.05)
        if not all(absent(pid, identity) for pid, identity in captured):
            raise RuntimeError('Public cancellation retained an owned process')
        if sentinel.poll() is not None:
            raise RuntimeError('Public cancellation retired unrelated sentinel')
        if child.returncode == 0 or engine_root.exists():
            raise RuntimeError('Public group cancellation did not finish graceful cleanup')
        print(json.dumps({'mode': 'public-group', 'actualHttpCompleted': True,
                          'ownedTreeGone': True, 'rootRemoved': True, 'sentinelAlive': True}))
    finally:
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=45)
        sentinel.terminate()
        sentinel.wait(timeout=5)
        shutil.rmtree(owned)
        if engine_root is not None and engine_root.exists():
            print('Public cancellation retained ' + str(engine_root), file=sys.stderr)


if sys.argv[1] == 'worker':
    worker(sys.argv[2], sys.argv[3])
elif sys.argv[1] == 'public-group':
    public_group(sys.argv[2])
else:
    parent(sys.argv[1])
