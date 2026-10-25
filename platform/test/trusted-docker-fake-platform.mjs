// Fixture deployment platform: a real observer claim whose generation ends at the daemon's SIGTERM.
import { renameSync, writeFileSync } from 'node:fs';
import { claimVerificationDockerObserver } from '../../scripts/verification-docker-generations.mjs';

const [bootstrap, authority, scenario] = process.argv.slice(2);
const root = new URL('../../.run/fake-daemon/', import.meta.url);
const publish = (name, value) => {
  const pending = new URL(`${name}.pending`, root);
  writeFileSync(pending, JSON.stringify(value));
  renameSync(pending, new URL(name, root));
};
const observer = claimVerificationDockerObserver(bootstrap, authority);
observer.initialize();
process.on('SIGTERM', () => {
  // The unsettled case exits cleanly while leaving its participant reservation pending.
  if (scenario !== 'unsettled') observer.finish();
  publish('platform-exit.json', { exitCode: 0, oom: false });
  process.exit(0);
});
publish('platform-ready.json', { pid: process.pid });
setInterval(() => undefined, 1000);
