"""Trusted Linux e2e owner; entered only as PID1 in an invocation namespace."""
import http.client
import json
import os
from pathlib import Path
import re
import selectors
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid


class UnixHttp(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(1)
        self.sock.connect(self.host)


def engine_info(path):
    connection = UnixHttp(str(path))
    try:
        connection.request('GET', '/info', headers={'Host': 'localhost'})
        response = connection.getresponse()
        body = response.read(1024 * 1024 + 1)
        if response.status != 200 or len(body) > 1024 * 1024:
            raise RuntimeError('Private Engine identity unavailable')
        return json.loads(body)
    finally:
        connection.close()


def stop(child):
    if child.poll() is not None:
        return True
    child.terminate()
    try:
        return child.wait(timeout=15) == 0
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=5)
        return False


def main():
    if os.getuid() != 0 or os.getpid() != 1:
        raise RuntimeError('Private Engine requires an owned PID namespace')
    uid, gid = int(sys.argv[1]), int(sys.argv[2])
    if uid <= 0 or gid <= 0 or uid != int(os.environ['SUDO_UID']) or gid != int(os.environ['SUDO_GID']):
        raise RuntimeError('Private Engine caller identity mismatch')
    caller_network = sys.argv[5]
    private_network = os.readlink('/proc/self/ns/net')
    if not re.fullmatch(r'net:\[\d+\]', caller_network) or private_network == caller_network:
        raise RuntimeError('Private Engine requires an owned network namespace')
    for executable in ('/usr/bin/dockerd', '/usr/bin/containerd', '/usr/bin/bash', '/usr/sbin/ip'):
        if not os.access(executable, os.X_OK):
            raise RuntimeError('Private Engine prerequisite unavailable')
    # Even --bridge=none deletes docker0 in the daemon's network namespace.
    # Only the already-proved private namespace may receive kernel network changes.
    subprocess.run(['/usr/sbin/ip', 'link', 'set', 'lo', 'up'], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=5)
    repository = Path(__file__).resolve().parent.parent
    caller_path, caller_home = sys.argv[3:5]
    watch = selectors.DefaultSelector()
    watch.register(sys.stdin, selectors.EVENT_READ)
    cancelled = False

    def cancel(*_):
        nonlocal cancelled
        cancelled = True

    def check_owner():
        if watch.select(0) or cancelled:
            raise RuntimeError('Private Engine invocation cancelled')

    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    root = None
    client = None
    daemons = []
    scenario = None
    cleaned = True
    completed = False
    log = None
    try:
        root = Path(tempfile.mkdtemp(prefix='dsh-team-e2e-engine-'))
        # Both roots are captured here; caller death cannot strand a caller-owned trap.
        # mkdtemp keeps privileged state root-only and the client directory private.
        client = Path(tempfile.mkdtemp(prefix='dsh-team-e2e-client-'))
        os.chown(client, uid, gid)
        nonce = str(uuid.uuid4())
        runtime_socket = root / 'containerd.sock'
        docker_socket = client / 'docker.sock'
        namespace = 'dsh-team-e2e-' + nonce
        log = (root / 'daemon.log').open('wb')
        os.chmod(root / 'daemon.log', 0o600)
        environment = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': str(root), 'LANG': 'C.UTF-8'}
        (root / 'containerd.toml').write_text('version = 3\ndisabled_plugins = ["io.containerd.cri.v1.images", "io.containerd.cri.v1.runtime", "io.containerd.grpc.v1.cri"]\n')
        (root / 'docker.json').write_text('{}\n')
        runtime = subprocess.Popen([
            '/usr/bin/containerd', '--config', str(root / 'containerd.toml'),
            '--root', str(root / 'runtime-data'), '--state', str(root / 'runtime-state'),
            '--address', str(runtime_socket),
        ], stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=environment)
        daemons.append(runtime)
        deadline = time.monotonic() + 20
        while not runtime_socket.exists():
            check_owner()
            if runtime.poll() is not None or time.monotonic() >= deadline:
                raise RuntimeError('Private container runtime did not start')
            time.sleep(.05)
        engine = subprocess.Popen([
            '/usr/bin/dockerd', '--config-file', str(root / 'docker.json'),
            '--data-root', str(root / 'docker-data'), '--exec-root', str(root / 'docker-exec'),
            '--pidfile', str(root / 'docker.pid'), '--host', 'unix://' + str(docker_socket),
            '--group', str(gid), '--storage-driver=vfs', '--bridge=none', '--iptables=false',
            '--ip6tables=false', '--ip-forward=false', '--ip-masq=false',
            '--containerd', str(runtime_socket), '--containerd-namespace', namespace,
            '--containerd-plugins-namespace', namespace + '-plugins', '--label', 'dsh-team.e2e=' + nonce,
        ], stdin=subprocess.DEVNULL, stdout=log, stderr=log, env=environment)
        daemons.append(engine)
        deadline = time.monotonic() + 20
        while True:
            check_owner()
            if any(child.poll() is not None for child in daemons) or time.monotonic() >= deadline:
                raise RuntimeError('Private Engine did not become ready')
            try:
                info = engine_info(docker_socket)
                break
            except (OSError, http.client.HTTPException):
                time.sleep(.05)
        if (info.get('DockerRootDir') != str(root / 'docker-data') or
                info.get('Driver') != 'vfs' or info.get('Containers') != 0 or
                'dsh-team.e2e=' + nonce not in info.get('Labels', []) or
                info.get('Containerd') != {'Address': str(runtime_socket), 'Namespaces': {
                    'Containers': namespace, 'Plugins': namespace + '-plugins'}}):
            raise RuntimeError('Private Engine identity mismatch')
        if any(os.readlink('/proc/%d/ns/net' % child.pid) != private_network for child in daemons):
            raise RuntimeError('Private daemon network namespace mismatch')

        def as_caller():
            os.setgroups([])
            os.setgid(gid)
            os.setuid(uid)
            os.setsid()

        check_owner()
        scenario = subprocess.Popen(['/usr/bin/bash', str(repository / 'scripts/e2e-scenario.sh')],
            cwd=repository, env={'PATH': caller_path, 'HOME': caller_home, 'LANG': 'C.UTF-8',
                'TMPDIR': str(client), 'PLATFORM_DOCKER_SOCKET': str(docker_socket)},
            stdin=subprocess.DEVNULL, preexec_fn=as_caller)
        while scenario.poll() is None:
            check_owner()
            if any(child.poll() is not None for child in daemons):
                raise RuntimeError('Private runtime exited during verification')
            time.sleep(.05)
        if scenario.returncode != 0:
            raise RuntimeError('Built-artifact scenario failed')
        completed = True
    finally:
        # Direct unreaped child handles are authority; never adopt a PID from disk.
        if scenario is not None and scenario.poll() is None:
            os.killpg(scenario.pid, signal.SIGTERM)
            try:
                scenario.wait(timeout=30)
            except subprocess.TimeoutExpired:
                cleaned = False
                os.killpg(scenario.pid, signal.SIGKILL)
                scenario.wait(timeout=5)
        for child in reversed(daemons):
            cleaned = stop(child) and cleaned
        if log is not None:
            log.close()
        watch.close()
        # Reap adopted descendants only after the direct child handles have settled.
        while True:
            try:
                if os.waitpid(-1, os.WNOHANG)[0] == 0:
                    cleaned = False
                    break
            except ChildProcessError:
                break
        if cleaned:
            for path in (client, root):
                if path is not None:
                    shutil.rmtree(path)
        else:
            print('e2e: incomplete cleanup; retained private paths ' + str((root, client)), file=sys.stderr)
        if not cleaned:
            raise RuntimeError('Private Engine cleanup incomplete')
    if completed:
        print('e2e: private Engine and runtime retired', flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # Daemon logs stay private; arbitrary storage/process errors are not public diagnostics.
        print('e2e: isolated runtime failed', file=sys.stderr)
        sys.exit(1)
