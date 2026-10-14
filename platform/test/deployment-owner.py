"""Release the test-owned FIFO at exact owner shutdown; report retirement ordering."""
import http.client
import json
import socket
import subprocess
import sys
import urllib.parse

owner_id, helper_id, config = sys.argv[1:]


class UnixConnection(http.client.HTTPConnection):
    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(15)
        self.sock.connect('/var/run/docker.sock')


connection = UnixConnection('localhost', timeout=15)
filters = {'container': [owner_id, helper_id], 'event': ['kill', 'die', 'destroy']}
connection.request('GET', '/events?filters=' + urllib.parse.quote(json.dumps(filters)))
response = connection.getresponse()
if response.status != 200:
    raise RuntimeError('Owner event subscription refused')
print('armed', flush=True)
released = False
helper_destroyed = False
owner_signal = None
try:
    while True:
        line = response.readline()
        if not line:
            raise RuntimeError('Event subscription ended before owner settlement')
        event = json.loads(line)
        identity = event.get('Actor', {}).get('ID')
        action = event.get('Action')
        attributes = event.get('Actor', {}).get('Attributes', {})
        if identity == helper_id and action == 'destroy':
            helper_destroyed = True
        if identity != owner_id:
            continue
        if action == 'kill':
            owner_signal = attributes.get('signal')
        if not released and (action == 'die' or owner_signal == '15'):
            # Replace the owned FIFO before releasing its reader so later DSH startup sees
            # an ordinary file. No DSH source, command, or release code is altered.
            script = r"""
const fs = require('node:fs');
const path = '/data/home/cordis.patch.yml';
const fd = fs.openSync(path, 'w');
fs.unlinkSync(path);
fs.writeFileSync(path, '[]\n');
fs.writeSync(fd, '[]\n');
fs.closeSync(fd);
"""
            result = subprocess.run(
                ['docker', '--config', config, 'exec', helper_id, 'node', '-e', script],
                timeout=10, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
            if result.returncode != 0:
                raise RuntimeError('Owned helper release failed')
            released = True
        if action == 'die':
            print(json.dumps({
                'signal': owner_signal,
                'helperDestroyedBeforeOwner': helper_destroyed,
                'ownerExitCode': attributes.get('exitCode'),
            }), flush=True)
            break
finally:
    connection.close()
