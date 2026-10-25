// Owned custody fixture daemon: the owner preload routes every docker/flock process here.
// It answers only from the fixture's private state file and never reaches a Docker Engine.
import { appendFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const root = new URL('../../.run/fake-daemon/', import.meta.url);
const [binary, ...args] = process.argv.slice(2);
const record = (call) => {
  appendFileSync(new URL('calls.jsonl', root), `${JSON.stringify(call)}\n`);
};
record([binary, ...args]);
const state = JSON.parse(readFileSync(new URL('state.json', root), 'utf8'));
const exitPath = new URL('platform-exit.json', root);

function reply(stdout, status = 0, stderr = '') {
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = status;
}

// Docker 29.1.3 exact-absence diagnostics, per kind.
function absent(kind, reference) {
  const diagnostic =
    kind === 'network'
      ? `network ${reference} not found`
      : kind === 'volume'
        ? `get ${reference}: no such volume`
        : `No such ${kind}: ${reference}`;
  reply('', 1, `Error response from daemon: ${diagnostic}\n`);
}

function platformExit() {
  return existsSync(exitPath) ? JSON.parse(readFileSync(exitPath, 'utf8')) : undefined;
}

function document(resource) {
  if (resource.kind === 'network')
    return { Id: resource.id, Name: resource.name, Labels: resource.labels, Containers: {} };
  if (resource.kind === 'volume') return { Name: resource.name, Labels: resource.labels };
  const exit = resource.platform ? platformExit() : undefined;
  return {
    Id: resource.id,
    Name: `/${resource.name}`,
    Config: { Labels: resource.labels },
    State:
      exit === undefined
        ? { Status: 'running', Running: true, ExitCode: 0, OOMKilled: false }
        : { Status: 'exited', Running: false, ExitCode: exit.exitCode, OOMKilled: exit.oom },
  };
}

function find(kind, reference) {
  return state.resources.find(
    (resource) =>
      resource.kind === kind && (resource.name === reference || resource.id === reference),
  );
}

function inspect(resource, rest) {
  const format = rest.indexOf('--format');
  if (format === -1) return reply(`${JSON.stringify([document(resource)])}\n`);
  const label = /"([^"]+)"/.exec(rest[format + 1] ?? '')?.[1] ?? '';
  reply(`${resource.labels[label] ?? '<no value>'}\n`);
}

function list(kind, rest) {
  const filters = rest.flatMap((value, index) =>
    rest[index - 1] === '--filter' ? [value.slice('label='.length)] : [],
  );
  const matches = state.resources.filter(
    (resource) =>
      resource.kind === kind &&
      filters.every((filter) => {
        const separator = filter.indexOf('=');
        return resource.labels[filter.slice(0, separator)] === filter.slice(separator + 1);
      }),
  );
  reply(matches.map((resource) => `${resource.id}\n`).join(''));
}

function remove(resource, reference) {
  state.resources = state.resources.filter((candidate) => candidate !== resource);
  const pending = new URL('state.json.pending', root);
  writeFileSync(pending, JSON.stringify(state));
  renameSync(pending, new URL('state.json', root));
  reply(`${reference}\n`);
}

async function wait() {
  const until = Date.now() + 10_000;
  while (platformExit() === undefined) {
    if (Date.now() >= until) return reply('', 1, 'fixture wait deadline\n');
    await delay(20);
  }
  reply(`${String(platformExit().exitCode)}\n`);
}

// Same handshake as `flock --nonblock <lock> node -e ...`; stdin EOF releases it.
function lock() {
  if (state.scenario === 'lock-unavailable') {
    process.exitCode = 1;
    return;
  }
  process.stdout.write('locked\n');
  process.stdin.resume();
  process.stdin.once('end', () => {
    record(['flock-released']);
  });
}

async function dispatch() {
  if (binary === 'flock') return lock();
  const scoped = ['container', 'image', 'network', 'volume'].includes(args[0]);
  const kind = scoped ? args[0] : 'container';
  const verb = scoped ? args[1] : args[0];
  const rest = args.slice(scoped ? 2 : 1);
  if (verb === 'ls') return list(kind, rest);
  const reference = rest.at(-1) ?? '';
  const resource = find(kind, reference);
  if (verb === 'wait') return wait();
  if (resource === undefined) return absent(kind, reference);
  if (verb === 'inspect') return inspect(resource, rest);
  if (verb === 'rm') return remove(resource, reference);
  if (verb === 'kill' && resource.platform) {
    process.kill(resource.pid, 'SIGTERM');
    return reply(`${resource.id}\n`);
  }
  reply('', 125, `fixture daemon refuses ${verb}\n`);
}

await dispatch();
