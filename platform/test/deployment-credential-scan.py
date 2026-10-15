import errno
import json
import os
import stat
import sys
import time

# Probe inputs are argv-only: never application environment or persisted files.
# Virtual devices/kernel memory are excluded; process environments are read below.
inputs = json.loads(sys.argv[1])
needles = [value.encode() for value in inputs['needles']]
marker = inputs['marker'].encode()
width = max(map(len, [*needles, marker, b'platform_sessions']))
started = time.monotonic()
result = dict(uid=os.geteuid(), files=0, bytes=0, denied=0, vanished=0,
              fileHits=False, envHits=False, database=False,
              fileMarker=False, envMarker=False, home=False, work=False)
visited = set()
virtual = ('/proc', '/sys', '/dev')


def bound():
    if result['files'] > 250000 or result['bytes'] > 4 * 1024**3 or time.monotonic() - started > 60:
        raise RuntimeError('Discovery bound exceeded')


def unavailable(error):
    if error.errno in (errno.EACCES, errno.EPERM):
        result['denied'] += 1
    elif error.errno in (errno.ENOENT, errno.ESRCH):
        result['vanished'] += 1
    else:
        raise RuntimeError('Unexpected discovery failure') from None


def inspect_file(path, environment=False):
    try:
        with open(path, 'rb') as stream:
            carry = b''
            first = True
            sqlite = False
            schema = False
            while True:
                bound()
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                result['bytes'] += len(chunk)
                data = carry + chunk
                if first:
                    sqlite = data.startswith(b'SQLite format 3\x00')
                    first = False
                schema |= b'platform_sessions' in data
                result['envHits' if environment else 'fileHits'] |= any(value in data for value in needles)
                result['envMarker' if environment else 'fileMarker'] |= marker in data
                carry = data[-width:]
            result['database'] |= sqlite and schema
            result['files'] += 1
            bound()
    except OSError as error:
        unavailable(error)


def visit(path):
    bound()
    resolved = os.path.realpath(path)
    if any(resolved == root or resolved.startswith(root + '/') for root in virtual):
        return
    try:
        info = os.stat(path)
        identity = (info.st_dev, info.st_ino)
        if identity in visited:
            return
        visited.add(identity)
        if path == '/data/home':
            result['home'] = True
        if path == '/data/work':
            result['work'] = True
        if os.path.basename(path).startswith('platform.db') or path == inputs['database']:
            result['database'] = True
        if stat.S_ISDIR(info.st_mode):
            with os.scandir(path) as entries:
                for entry in entries:
                    visit(entry.path)
        elif stat.S_ISREG(info.st_mode):
            inspect_file(path)
    except OSError as error:
        unavailable(error)


try:
    visit('/')
    for name in os.listdir('/proc'):
        if name.isdecimal():
            inspect_file('/proc/' + name + '/environ', True)
    bound()
    print(json.dumps(result))
except Exception:
    # Never emit a path, input, credential or exception excerpt.
    print(json.dumps({'failure': 'Credential discovery failed'}))
    sys.exit(1)
