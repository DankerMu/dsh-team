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


class FaultPhaseUnavailable(RuntimeError):
    pass


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


def worker(mode, owned, caller_network):
    unrelated = mode == 'unrelated-identity'
    if unrelated:
        mode = 'identity'
    repository = Path(__file__).resolve().parents[2]
    spec = importlib.util.spec_from_file_location('e2e_owner', repository / 'scripts/e2e-engine-supervisor.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    original_spawn = module.subprocess.Popen
    original_run = module.subprocess.run
    original_info = module.engine_info
    original_mkdtemp = module.tempfile.mkdtemp
    original_open = module.Path.open
    original_access = module.os.access
    original_pid = module.os.getpid
    original_readlink = module.os.readlink
    phase = None
    mutations = {'network': 0, 'daemons': []}

    def checkpoint():
        nonlocal phase
        if phase is not None:
            raise RuntimeError('Duplicate fault boundary')
        phase = mode
        print(json.dumps({'phase': phase}), flush=True)
        # Parent observes actual host-visible child identities while this boundary is held.
        if sys.stdin.readline() != 'continue\n':
            raise FaultPhaseUnavailable('Fault observer departed')

    def observed_pid():
        pid = original_pid()
        if mode == 'prerequisite':
            checkpoint()
        return pid

    def observed_readlink(path, *args, **kwargs):
        value = original_readlink(path, *args, **kwargs)
        if mode == 'network' and path == '/proc/self/ns/net':
            checkpoint()
        return value

    def open_path(path, *args, **kwargs):
        if mode == 'setup' and path.name == 'daemon.log':
            checkpoint()
            raise PermissionError('injected owned log creation failure')
        return original_open(path, *args, **kwargs)

    def executable(path, permission):
        if unrelated:
            raise RuntimeError('Injected failure before identity observation')
        if mode == 'executable' and path == '/usr/bin/containerd':
            checkpoint()
            return False
        return original_access(path, permission)

    def create_root(*args, **kwargs):
        return original_mkdtemp(*args, **kwargs, dir=owned)

    def observed_info(path):
        info = original_info(path)
        if mode == 'identity':
            checkpoint()
            info['DockerRootDir'] = '/not-the-owned-root'
        return info

    def external_run(args, **kwargs):
        if args[0] == '/usr/sbin/ip':
            mutations['network'] += 1
            if mode in ('prerequisite', 'network', 'executable'):
                raise RuntimeError('Forbidden network admission during early refusal')
        return original_run(args, **kwargs)

    def external_process(args, **kwargs):
        if args[0] in ('/usr/bin/containerd', '/usr/bin/dockerd'):
            mutations['daemons'].append(args[0])
            if mode in ('prerequisite', 'network', 'executable', 'setup'):
                raise RuntimeError('Forbidden daemon admission during early refusal')
        if args[0] == '/usr/bin/dockerd' and mode == 'partial':
            checkpoint()
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
    module.subprocess.run = external_run
    module.Path.open = open_path
    module.os.access = executable
    module.os.getpid = observed_pid
    module.os.readlink = observed_readlink
    sys.argv = [str(repository / 'scripts/e2e-engine-supervisor.py'), os.environ['SUDO_UID'],
                os.environ['SUDO_GID'], '/usr/bin:/bin', '/home/ubuntu', caller_network]
    try:
        module.main()
    except Exception as error:
        expected_type = PermissionError if mode == 'setup' else RuntimeError
        if phase == mode and type(error) is expected_type:
            print(json.dumps({'rejected': mode, 'mutations': mutations}), flush=True)
        else:
            print(json.dumps({'unqualified': True}), flush=True)
        raise SystemExit(1)


def parent(mode, host_network):
    if os.getuid() != 0 or int(os.environ['SUDO_UID']) <= 0:
        raise RuntimeError('Trusted nonroot sudo invocation required')
    if os.readlink('/proc/self/ns/net') == host_network:
        raise RuntimeError('Fault qualification requires an independent outer network namespace')
    target = 'identity' if mode == 'unrelated-identity' else mode
    early = target in ('prerequisite', 'network', 'executable', 'setup', 'partial', 'identity')
    network_before = None
    if target == 'network':
        subprocess.run(['/usr/sbin/ip', 'link', 'add', 'docker0', 'type', 'bridge'], check=True)
        network_before = json.loads(subprocess.run(['/usr/sbin/ip', '-j', 'link', 'show', 'docker0'],
            text=True, capture_output=True, check=True).stdout)[0]
    owned = Path(tempfile.mkdtemp(prefix='dsh-team-e2e-fixture-'))
    sentinel = subprocess.Popen(['/usr/bin/sleep', '300'])
    child = None
    captured = []
    success = False
    try:
        worker_args = ['/usr/bin/python3', str(Path(__file__).resolve()), 'worker', mode, str(owned),
                       os.readlink('/proc/self/ns/net')]
        args = ['/usr/bin/unshare', '--fork', '--pid', '--mount-proc',
                *([] if mode == 'network' else ['--net']),
                '--propagation', 'private', '--kill-child=SIGKILL', *worker_args]
        if mode == 'prerequisite':
            args = worker_args
        elif mode == 'parent-kill':
            # A separate producer owns the sole write end, just like the public Node entry.
            producer = 'import subprocess,sys,json; child=subprocess.Popen(json.loads(sys.argv[1]),stdin=subprocess.PIPE); child.wait()'
            args = ['/usr/bin/python3', '-c', producer, json.dumps(args)]
        child = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                 stderr=subprocess.DEVNULL, text=True)
        if early:
            selector = selectors.DefaultSelector()
            selector.register(child.stdout, selectors.EVENT_READ)
            try:
                if not selector.select(30):
                    raise FaultPhaseUnavailable('Fault boundary not reached')
                line = child.stdout.readline()
                if not line or json.loads(line) != {'phase': target}:
                    raise FaultPhaseUnavailable('Fault boundary not reached')
            finally:
                selector.close()
            if target == 'prerequisite':
                supervisor = child.pid
            else:
                roots = children(child.pid)
                if len(roots) != 1:
                    raise RuntimeError('Fault supervisor identity unavailable')
                supervisor = roots[0]
            descendants = children(supervisor)
            expected = {
                'partial': ['/usr/bin/containerd'],
                'identity': ['/usr/bin/containerd', '/usr/bin/dockerd'],
            }.get(target, [])
            actual = sorted((Path('/proc') / str(pid) / 'cmdline').read_bytes().split(b'\0')[0].decode()
                            for pid in descendants)
            if actual != expected:
                raise RuntimeError('Fault phase did not observe its real runtime processes')
            captured = [(pid, birth(pid)[0]) for pid in [supervisor, *descendants]]
            child.stdin.write('continue\n')
            child.stdin.flush()
        if mode in ('eof', 'supervisor-kill', 'parent-kill'):
            selector = selectors.DefaultSelector()
            selector.register(child.stdout, selectors.EVENT_READ)
            try:
                if not selector.select(30) or child.stdout.readline().strip() != 'scenario-ready':
                    raise RuntimeError('Real private scenario did not reach hold')
            finally:
                selector.close()
            private_roots = list(owned.iterdir())
            if len(private_roots) != 2:
                raise RuntimeError('Private root identities unavailable')
            for path in private_roots:
                permissions = path.stat()
                expected_uid = 0 if path.name.startswith('dsh-team-e2e-engine-') else int(os.environ['SUDO_UID'])
                if permissions.st_uid != expected_uid or permissions.st_mode & 0o777 != 0o700:
                    raise RuntimeError('Private root permissions exceed its owner')
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
        if early:
            expected_daemons = ['/usr/bin/containerd', '/usr/bin/dockerd'] if target in ('partial', 'identity') else []
            expected_network = 0 if target in ('prerequisite', 'network', 'executable') else 1
            if json.loads(child.stdout.read()) != {
                    'rejected': target, 'mutations': {'network': expected_network, 'daemons': expected_daemons}}:
                raise RuntimeError('Selected fault was not the observed rejection')
        if network_before is not None:
            network_after = json.loads(subprocess.run(['/usr/sbin/ip', '-j', 'link', 'show', 'docker0'],
                text=True, capture_output=True, check=True).stdout)[0]
            if any(network_after[key] != network_before[key] for key in ('ifindex', 'ifname', 'address', 'mtu')):
                raise RuntimeError('Fault qualification mutated its caller network')
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
        if success or (child is not None and child.poll() is not None and not list(owned.iterdir())):
            # The parent created this exact root before worker admission. A killed PID1
            # has settled its mount namespace and children before this rescue removes it.
            shutil.rmtree(owned)
        else:
            print('e2e fault fixture retained ' + str(owned), file=sys.stderr)
            raise RuntimeError('Fault fixture cleanup unconfirmed')


def public_group(caller_path, preserve_network=False):
    import pwd
    import shlex
    uid, gid = int(os.environ['SUDO_UID']), int(os.environ['SUDO_GID'])
    if os.getuid() != 0 or uid <= 0:
        raise RuntimeError('Trusted nonroot sudo invocation required')
    network_before = json.loads(subprocess.run(['/usr/sbin/ip', '-j', 'link', 'show', 'docker0'],
        text=True, capture_output=True, check=True).stdout)[0]
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
    client_root = None
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
        daemon_candidates = []
        while pending:
            pid = pending.pop()
            identity = birth(pid)
            if identity is None:
                continue
            try:
                descendants = children(pid)
                args = (Path('/proc') / str(pid) / 'cmdline').read_bytes().split(b'\0')
            except FileNotFoundError:
                if absent(pid, identity[0]):
                    continue
                raise
            if absent(pid, identity[0]):
                continue
            captured.append((pid, identity[0]))
            pending.extend(descendants)
            if args[0] in (b'/usr/bin/dockerd', b'/usr/bin/containerd'):
                daemon_candidates.append((pid, identity[0]))
            if args[0] == b'/usr/bin/dockerd':
                path = Path(os.fsdecode(args[args.index(b'--data-root') + 1])).parent
                if path.parent != Path('/tmp') or not path.name.startswith('dsh-team-e2e-engine-'):
                    raise RuntimeError('Owned daemon root mismatch')
                engine_roots.append(path)
                client_root = Path(os.fsdecode(args[args.index(b'--host') + 1]).removeprefix('unix://')).parent
                if client_root.parent != Path('/tmp') or not client_root.name.startswith('dsh-team-e2e-client-'):
                    raise RuntimeError('Owned client root mismatch')
        if len(engine_roots) != 1 or client_root is None:
            raise RuntimeError('Actual private daemon not observed')
        engine_root = engine_roots[0]
        observed = subprocess.run(['/usr/sbin/ip', '-j', 'link', 'show', 'docker0'],
                                  text=True, capture_output=True)
        if observed.returncode != 0:
            raise RuntimeError('Private daemon deleted caller default bridge')
        network_after = json.loads(observed.stdout)[0]
        if any(network_after[key] != network_before[key] for key in ('ifindex', 'ifname', 'address', 'mtu')):
            raise RuntimeError('Private daemon replaced caller default bridge')
        observed_daemons = 0
        for pid, identity in daemon_candidates:
            if absent(pid, identity):
                raise RuntimeError('Observed private daemon exited before cancellation')
            network = os.readlink('/proc/%d/ns/net' % pid)
            if absent(pid, identity) or network == os.readlink('/proc/self/ns/net'):
                raise RuntimeError('Private daemon network identity changed')
            observed_daemons += 1
        if observed_daemons != 2:
            raise RuntimeError('Both private daemon namespaces were not observed')
        os.killpg(child.pid, signal.SIGTERM)
        child.wait(timeout=45)
        deadline = time.monotonic() + 45
        while not all(absent(pid, identity) for pid, identity in captured) and time.monotonic() < deadline:
            time.sleep(.05)
        if not all(absent(pid, identity) for pid, identity in captured):
            raise RuntimeError('Public cancellation retained an owned process')
        if sentinel.poll() is not None:
            raise RuntimeError('Public cancellation retired unrelated sentinel')
        if child.returncode == 0 or engine_root.exists() or client_root.exists():
            raise RuntimeError('Public group cancellation did not finish graceful cleanup')
        network_retired = json.loads(subprocess.run(['/usr/sbin/ip', '-j', 'link', 'show', 'docker0'],
            text=True, capture_output=True, check=True).stdout)[0]
        if any(network_retired[key] != network_before[key] for key in ('ifindex', 'ifname', 'address', 'mtu')):
            raise RuntimeError('Private retirement changed caller default bridge')
        print(json.dumps({'mode': 'network-sentinel' if preserve_network else 'public-group', 'actualHttpCompleted': True,
                          'ownedTreeGone': True, 'rootRemoved': True, 'sentinelAlive': True}))
    finally:
        if child is not None and child.poll() is None:
            os.killpg(child.pid, signal.SIGTERM)
            child.wait(timeout=45)
        deadline = time.monotonic() + 45
        while not all(absent(pid, identity) for pid, identity in captured) and time.monotonic() < deadline:
            time.sleep(.05)
        sentinel.terminate()
        sentinel.wait(timeout=5)
        shutil.rmtree(owned)
        for path in (engine_root, client_root):
            if path is not None and path.exists():
                print('Public cancellation retained ' + str(path), file=sys.stderr)


def custody(caller_path):
    import shlex
    uid, gid = int(os.environ['SUDO_UID']), int(os.environ['SUDO_GID'])
    if os.getuid() != 0 or uid <= 0:
        raise RuntimeError('Trusted nonroot sudo invocation required')
    source = Path(__file__).resolve().parents[2]
    owned = Path(tempfile.mkdtemp(prefix='dsh-team-e2e-fixture-'))
    repository, home, tools = (owned / name for name in ('repository', 'home', 'bin'))
    for path in (repository, home, tools):
        path.mkdir(mode=0o700)
    environment = {'PATH': str(tools) + ':' + caller_path, 'HOME': str(home), 'LANG': 'C.UTF-8'}
    listed = subprocess.run(['git', 'ls-files', '-z'], cwd=source, user=uid, group=gid,
                            extra_groups=[], env={'PATH': caller_path}, capture_output=True,
                            check=True, timeout=30).stdout.decode().split('\0')
    # Copy only reviewed source paths, never ignored credentials or private evidence.
    for relative in set(filter(None, listed)) | {
            'platform/test/e2e-command-fixture.ts',
            'scripts/verification-submissions.mjs', 'scripts/verification-producer.mjs',
            'scripts/docker-command.mjs',
            'scripts/verification-docker-observer.mjs',
            'scripts/verification-submission-storage.mjs',
            'scripts/verification-submission-assessment.mjs',
            'scripts/verification-docker-generations.mjs',
            'scripts/probe-browser-exec.mjs', 'scripts/probe-browser-exec.d.mts',
            'platform/test/deployed-docker-observer-fixture.ts',
            'platform/test/deployed-docker-engine-fixture.ts',
            'platform/test/trusted-docker-audit-fixture.ts',
            'platform/test/deployment-observer-fixture.ts',
            'scripts/verification-producer-exit.py'}:
        if Path(relative).name == '.env':
            raise RuntimeError('Secret file is not a verification fixture input')
        destination = repository / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / relative, destination, follow_symlinks=False)
    for relative in ('node_modules', 'platform/node_modules', 'platform/web/node_modules'):
        dependency = source / relative
        if dependency.is_dir():
            (repository / relative).symlink_to(dependency, target_is_directory=True)
    marker = owned / 'http-complete'
    real_hurl = shutil.which('hurl', path=caller_path)
    if real_hurl is None:
        raise RuntimeError('Actual HTTP verification prerequisite unavailable')
    shim = tools / 'hurl'
    shim.write_text('#!/bin/sh\n' + shlex.quote(real_hurl) + ' "$@" || exit $?\n' +
                    'touch ' + shlex.quote(str(marker)) + '\nexec /usr/bin/sleep 300\n')
    shim.chmod(0o700)
    package = json.loads((repository / 'package.json').read_text())
    package['scripts']['test:docker'] = 'node custody-probe.mjs'
    (repository / 'package.json').write_text(json.dumps(package) + '\n')
    (repository / 'custody-probe.mjs').write_text(
        "import {runE2e} from './platform/test/e2e-command-fixture.ts';\n" +
        'await runE2e(' + json.dumps(str(repository)) + ');\n')
    for current, directories, files in os.walk(owned, followlinks=False):
        for path in [Path(current), *(Path(current) / name for name in directories + files)]:
            os.chown(path, uid, gid, follow_symlinks=False)

    def command(*args):
        return subprocess.run(['pnpm', '--silent', 'verify:docker', *args], cwd=repository,
                              user=uid, group=gid, extra_groups=[], env=environment,
                              text=True, capture_output=True, timeout=30)

    for arguments in (['init', '--quiet'], ['add', '.'],
                      ['-c', 'user.name=fixture', '-c', 'user.email=fixture@localhost',
                       'commit', '--quiet', '-m', 'test: private e2e custody']):
        subprocess.run(['git', *arguments], cwd=repository, user=uid, group=gid,
                       extra_groups=[], env=environment, check=True, capture_output=True, timeout=30)
    head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=repository, user=uid, group=gid,
                          extra_groups=[], env=environment, check=True, capture_output=True,
                          text=True, timeout=30).stdout.strip()
    sentinel = subprocess.Popen(['/usr/bin/sleep', '300'])
    captured, launchers, roots = [], [], []
    start = None
    temporary = None
    temporary_identity = None
    failure = None
    cleanup_failures = []
    success = False
    def capture(child):
        root = birth(child['pid'])
        if root is None:
            return
        if 'linux:' + str(child['pid']) + ':' + root[0] != child['birth']:
            raise RuntimeError('Captured custody child generation changed')
        pending = [child['pid']]
        while pending:
            pid = pending.pop()
            identity = birth(pid)
            if identity is None:
                continue
            try:
                descendants = children(pid)
                args = (Path('/proc') / str(pid) / 'cmdline').read_bytes().split(b'\0')
            except FileNotFoundError:
                if absent(pid, identity[0]):
                    continue
                raise
            if absent(pid, identity[0]):
                continue
            if (pid, identity[0]) not in captured:
                captured.append((pid, identity[0]))
            pending.extend(descendants)
            if str(repository / 'scripts/e2e-engine.mjs').encode() in args:
                if (pid, identity[0]) not in launchers:
                    launchers.append((pid, identity[0]))
            if args[0] == b'/usr/bin/dockerd':
                engine = Path(os.fsdecode(args[args.index(b'--data-root') + 1])).parent
                client = Path(os.fsdecode(args[args.index(b'--host') + 1]).removeprefix('unix://')).parent
                for path, prefix, owner in ((engine, 'dsh-team-e2e-engine-', 0),
                                            (client, 'dsh-team-e2e-client-', uid)):
                    info = path.stat()
                    if path.parent != Path('/tmp') or not path.name.startswith(prefix) or info.st_uid != owner:
                        raise RuntimeError('Private runtime authority mismatch')
                    if path not in roots:
                        roots.append(path)
                if os.readlink('/proc/%d/ns/net' % pid) == os.readlink('/proc/self/ns/net'):
                    raise RuntimeError('Private Engine shares caller network namespace')
    try:
        started = command('start', head)
        if started.returncode != 0:
            raise RuntimeError('Custody admission failed')
        start = json.loads(started.stdout)
        directory = Path(start['directory'])
        requested = json.loads((directory / 'request.json').read_text())
        temporary = Path(requested['temporary'])
        temporary_identity = temporary.stat()
        if temporary.parent != Path('/tmp') or not temporary.name.startswith('dsh-team-docker-') or temporary_identity.st_uid != uid:
            raise RuntimeError('Custody temporary authority mismatch')
        deadline = time.monotonic() + 40
        while not marker.exists():
            child_path = directory / 'child.json'
            if child_path.exists():
                capture(json.loads(child_path.read_text())['owner'])
            if (directory / 'result.json').exists() or time.monotonic() >= deadline:
                raise RuntimeError('Actual custody e2e did not complete HTTP before hold')
            time.sleep(.05)
        child = json.loads((directory / 'child.json').read_text())['owner']
        capture(child)
        if len(launchers) != 1 or len(roots) != 2:
            raise RuntimeError('Exact detached launcher and private Engine were not observed')
        (owned / 'authority.json').write_text(json.dumps({
            'invocation': start['invocation'], 'owner': start['owner'],
            'captured': captured, 'launchers': launchers,
            'roots': [{'path': str(path), 'device': path.stat().st_dev,
                       'inode': path.stat().st_ino, 'uid': path.stat().st_uid} for path in roots],
        }))
        if command('cancel', start['invocation']).returncode != 0:
            raise RuntimeError('Matching custody cancellation failed')
        deadline = time.monotonic() + 45
        while not (directory / 'result.json').exists():
            if time.monotonic() >= deadline:
                raise RuntimeError('Custody did not publish terminal evidence')
            time.sleep(.05)
        result = command('status', start['invocation'])
        if result.returncode != 0:
            raise RuntimeError('Custody terminal evidence unavailable')
        terminal = json.loads(result.stdout)
        if any(not absent(pid, identity) for pid, identity in captured):
            raise RuntimeError('Custody published terminal evidence before owned retirement')
        if terminal['command']['settled'] is not True or terminal['cleanup']['state'] != 'confirmed':
            raise RuntimeError('Joined custody cancellation did not confirm retirement')
        if terminal['interruption'] != 'cancelled' or terminal['state'] != 'failed' or not terminal['output']['complete']:
            raise RuntimeError('Custody lost the original cancellation outcome')
        if sentinel.poll() is not None or any(path.exists() for path in roots):
            raise RuntimeError('Custody did not preserve sentinel and canonical cleanup')
        success = True
        print(json.dumps({'actualHttpCompleted': True, 'ownedTreeGoneAtTerminal': True,
                          'canonicalRootsRemoved': True, 'sentinelAlive': True,
                          'originalCancellationPreserved': True}), flush=True)
    except Exception as error:
        failure = error
    finally:
        if start is not None:
            try:
                command('cancel', start['invocation'])
            except Exception as error:
                cleanup_failures.append(error)
        # Emergency fixture retirement uses only the launcher captured before cancellation.
        for pid, identity in launchers:
            try:
                if not absent(pid, identity):
                    args = (Path('/proc') / str(pid) / 'cmdline').read_bytes().split(b'\0')
                    if str(repository / 'scripts/e2e-engine.mjs').encode() not in args or absent(pid, identity):
                        raise RuntimeError('Captured fixture launcher authority changed')
                    os.kill(pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            except Exception as error:
                cleanup_failures.append(error)
        deadline = time.monotonic() + 45
        while (any(not absent(pid, identity) for pid, identity in captured) or
               (start is not None and not absent(start['owner']['pid'], start['owner']['birth'].split(':')[-1]))) and time.monotonic() < deadline:
            time.sleep(.05)
        if sentinel.poll() is None:
            sentinel.terminate()
        sentinel.wait(timeout=5)
        owner_gone = start is None or absent(start['owner']['pid'], start['owner']['birth'].split(':')[-1])
        if success and owner_gone and not cleanup_failures and all(absent(pid, identity) for pid, identity in captured) and not any(path.exists() for path in roots):
            if temporary is not None:
                current = temporary.stat()
                if current.st_dev != temporary_identity.st_dev or current.st_ino != temporary_identity.st_ino:
                    raise RuntimeError('Custody temporary authority changed')
                shutil.rmtree(temporary)
            shutil.rmtree(owned)
        else:
            print('Custody fixture retained ' + str(owned), file=sys.stderr)
            cleanup_failures.append(RuntimeError('Custody fixture cleanup unconfirmed'))
    if failure is not None or cleanup_failures:
        raise ExceptionGroup('Custody scenario and cleanup failed',
                             ([failure] if failure is not None else []) + cleanup_failures)


if sys.argv[1] == 'worker':
    worker(sys.argv[2], sys.argv[3], sys.argv[4])
elif sys.argv[1] == 'public-group':
    public_group(sys.argv[2])
elif sys.argv[1] == 'custody':
    custody(sys.argv[2])
elif sys.argv[1] == 'network-sentinel':
    if os.readlink('/proc/self/ns/net') == sys.argv[3]:
        raise RuntimeError('Sentinel requires an invocation-owned network namespace')
    subprocess.run(['/usr/sbin/ip', 'link', 'set', 'lo', 'up'], check=True)
    subprocess.run(['/usr/sbin/ip', 'link', 'add', 'docker0', 'type', 'bridge'], check=True)
    public_group(sys.argv[2], preserve_network=True)
else:
    try:
        parent(sys.argv[1], sys.argv[2])
    except FaultPhaseUnavailable:
        print(json.dumps({'outcome': 'unqualified', 'reason': 'fault-phase-unobserved'}))
        sys.exit(1)
