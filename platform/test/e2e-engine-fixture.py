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
        if mode in ('partial', 'identity', 'prerequisite') and 'scenario-ready' in child.stdout.read():
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


if sys.argv[1] == 'worker':
    worker(sys.argv[2], sys.argv[3])
else:
    parent(sys.argv[1])
