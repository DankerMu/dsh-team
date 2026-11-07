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
/** One 1s connect per host and port; a single port would render a Python int, not a tuple. */
export function probeScript(ports: readonly number[]): string {
  if (ports.length < 2) throw new Error('Probe needs at least two ports');
  return `
import json, socket, sys
results = []
for host in sys.argv[1:]:
    for port in (${ports.join(', ')}):
        try:
            with socket.create_connection((host, port), timeout=1): results.append(True)
        except OSError: results.append(False)
print(json.dumps(results))
`;
}
// The model acceptance embeds these exact bytes in a real Agent prompt; keep them stable.
export const probe = probeScript([3080, 3099]);
