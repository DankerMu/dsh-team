export const listen = `
import json, os, socket, subprocess, sys, time
subprocess.Popen([sys.executable, '-m', 'http.server', '3099', '--bind', '0.0.0.0'],
                 cwd='/data/work', stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                 stderr=subprocess.DEVNULL, start_new_session=True)
deadline = time.monotonic() + 5
while True:
    try:
        with socket.create_connection(('127.0.0.1', 3099), timeout=.25): break
    except OSError:
        if time.monotonic() >= deadline: raise RuntimeError('Listener unavailable')
        time.sleep(.05)
print(json.dumps({'uid': os.geteuid(), 'port': 3099}))
`;
export const probe = `
import json, socket, sys
results = []
for host in sys.argv[1:]:
    for port in (3080, 3099):
        try:
            with socket.create_connection((host, port), timeout=1): results.append(True)
        except OSError: results.append(False)
print(json.dumps(results))
`;
