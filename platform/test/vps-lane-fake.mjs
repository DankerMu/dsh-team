// Fake docker/pnpm/gh/systemctl/ip for the parent-side VPS lane tests (vps-lane-fixture.ts).
// Shims call `node vps-lane-fake.mjs <state> <tool> ...`. Every call is appended to
// <state>/calls.log as `tool\x1farg\x1farg...`; answers come only from <state>/scenario.json,
// so no real Docker Engine, GitHub or host is ever reached.
import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [state, tool, ...args] = process.argv.slice(2);
appendFileSync(join(state, 'calls.log'), `${[tool, ...args].join('\x1f')}\n`);
const scenario = JSON.parse(readFileSync(join(state, 'scenario.json'), 'utf8'));
const host = () =>
  existsSync(join(state, 'custody-started')) ? scenario.hostAfter : scenario.hostBefore;
const out = (text) => process.stdout.write(text);
const fail = (message, code = 1) => {
  process.stderr.write(`${message}\n`);
  process.exitCode = code;
};
const lines = (values) => out(values.map((value) => `${value}\n`).join(''));
const json = (file) => JSON.parse(readFileSync(join(state, file), 'utf8'));
const save = (file, value) => writeFileSync(join(state, file), JSON.stringify(value));

/** Pops the next scripted answer; the last one repeats. */
function next(name, values) {
  const file = join(state, `${name}.index`);
  const index = existsSync(file) ? Number(readFileSync(file, 'utf8')) : 0;
  writeFileSync(file, String(index + 1));
  return values[Math.min(index, values.length - 1)];
}

const imageTag = (role) => join(state, 'images', role);
const roleOf = (tag) => tag.slice(tag.lastIndexOf(':') + 1);

function localDocker() {
  const tag = args.at(-1) ?? '';
  if (args[0] === 'buildx') {
    const tagged = args[args.indexOf('-t') + 1];
    if (scenario.buildFail === roleOf(tagged)) return fail('ERROR: failed to solve: exit code 1');
    mkdirSync(join(state, 'images'), { recursive: true });
    return writeFileSync(imageTag(roleOf(tagged)), tagged);
  }
  if (args[0] === 'save') {
    copyFileSync(scenario.oci[roleOf(tag)], args[args.indexOf('-o') + 1]);
    return undefined;
  }
  if (!existsSync(imageTag(roleOf(tag)))) return fail(`Error: No such image: ${tag}`);
  if (args[0] === 'image' && args[1] === 'inspect') {
    const id = createHash('sha256').update(tag).digest('hex');
    return out(`sha256:${id}|linux/amd64\n`);
  }
  rmSync(imageTag(roleOf(tag)));
  return out(`Untagged: ${tag}\n`);
}

function remoteDocker() {
  const view = host();
  const listing = {
    'ps -a --format {{.ID}} {{.Names}}': view.containers.map((c) => `${c.id} ${c.name}`),
    'ps -a --format {{.Names}}': view.containers.map((c) => c.name),
    'volume ls --format {{.Name}}': view.volumes,
    'network ls --format {{.Name}}': view.networks,
    'image ls --format {{.Repository}}:{{.Tag}}': view.images,
    'image ls -q --filter label=dsh-team.test-run': view.labelledImages,
  }[args.join(' ')];
  if (listing) return lines(listing);
  if (args[0] === 'inspect') {
    const container = view.containers.find((c) => c.id === args.at(-1));
    return container ? out(`${container.detail}\n`) : fail('Error: No such object');
  }
  if (args[1] === 'inspect')
    return view.present.includes(args[2])
      ? out('[{}]\n')
      : fail(`Error: No such ${args[0]}: ${args[2]}`);
  return fail(`fake docker: unexpected ${args.join(' ')}`, 97);
}

function docker() {
  // The lane's own image calls; the host observer only lists, inspects by name or by ID.
  const own = `${args[0]} ${args[1]}`;
  const local =
    ['buildx', 'save'].includes(args[0]) ||
    own === 'image rm' ||
    (own === 'image inspect' && args[2] === '--format');
  return local ? localDocker() : remoteDocker();
}

function custody() {
  const [operation, identity] = args.slice(2);
  if (operation === 'start') {
    const invocation = randomUUID();
    const directory = join(homedir(), '.local/share/dsh-team/docker-verification', invocation);
    mkdirSync(directory, { recursive: true });
    const journal = scenario.targets.map((target) => JSON.stringify({ runId: 'r', target }));
    writeFileSync(join(directory, 'resources.jsonl'), journal.map((l) => `${l}\n`).join(''));
    save('custody-start-env.json', {
      names: Object.keys(process.env).sort(),
      images: process.env.DSH_TEAM_VERIFICATION_IMAGES,
      cwd: process.cwd(),
    });
    writeFileSync(join(state, 'custody-started'), invocation);
    const owner = { pid: 1, birth: 'linux:1:1' };
    return out(`${JSON.stringify({ invocation, head: identity, directory, owner })}\n`);
  }
  const invocation = readFileSync(join(state, 'custody-started'), 'utf8');
  if (identity !== invocation) return fail('unknown invocation');
  if (operation === 'logs')
    return scenario.logsFail
      ? fail('Trusted Docker output authority incomplete')
      : out(scenario.stdout);
  const status = next('status', scenario.statuses);
  if (status === 'fail') return fail('Trusted Docker custody operation failed');
  return out(`${JSON.stringify({ invocation, root: process.cwd(), ...status })}\n`);
}

function pnpm() {
  if (args[0] === '--silent' && args[1] === 'verify:docker') return custody();
  const step = args[0] === 'install' ? 'install' : args[0];
  const journal = process.env.DSH_TEAM_CI_RESOURCE_JOURNAL;
  if (step === 'test:deploy' && journal)
    for (const target of scenario.deployTargets ?? [])
      appendFileSync(journal, `${JSON.stringify({ runId: 'd', target })}\n`);
  save(`pnpm-${step.replace(':', '-')}-env.json`, Object.keys(process.env).sort());
  out(scenario.output?.[step] ?? `${step} done\n`);
  process.exitCode = scenario.exits?.[step] ?? 0;
  return undefined;
}

function systemctl() {
  const text = args.join(' ');
  if (text === 'show docker.service --property=MainPID --value')
    return out(`${host().daemonPid}\n`);
  if (text.startsWith('--user list-units')) return lines(host().activeUnits);
  if (text.startsWith('--user show -p SubState --value ')) {
    const file = join(state, 'units', args.at(-1));
    return out(`${existsSync(file) ? readFileSync(file, 'utf8').trim() : 'dead'}\n`);
  }
  return fail(`fake systemctl: unexpected ${text}`, 97);
}

function ghApi() {
  const gh = json('gh.json');
  if (args[1] === 'user') return out(`${gh.login}\n`);
  if (gh.failStatus > 0) {
    save('gh.json', { ...gh, failStatus: gh.failStatus - 1 });
    return fail('HTTP 502: Bad Gateway');
  }
  const field = (name) =>
    args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
  const status = {
    sha: args
      .find((value) => value.includes('/statuses/'))
      ?.split('/')
      .at(-1),
    state: field('state'),
    context: field('context'),
    description: field('description'),
    creator: { login: gh.login },
  };
  save('gh.json', { ...gh, statuses: [status, ...gh.statuses] });
  return out(`${JSON.stringify(status)}\n`);
}

function gh() {
  const gh = json('gh.json');
  const command = `${args[0]} ${args[1]}`;
  if (args[0] === 'api') return ghApi();
  if (command === 'pr view')
    return out(`${JSON.stringify({ headRefOid: gh.head, body: gh.body })}\n`);
  if (command === 'pr edit') {
    if (gh.failEdit > 0) {
      save('gh.json', { ...gh, failEdit: gh.failEdit - 1 });
      return fail('GraphQL: Something went wrong');
    }
    return save('gh.json', { ...gh, body: readFileSync(0, 'utf8'), edits: gh.edits + 1 });
  }
  if (command === 'run list') {
    const head = args[args.indexOf('--commit') + 1];
    return out(`${JSON.stringify(gh.runs.filter((run) => run.headSha === head))}\n`);
  }
  if (command === 'run rerun') return out(`Requested rerun of run ${args[2]}\n`);
  return fail(`fake gh: unexpected ${args.join(' ')}`, 97);
}

const tools = {
  docker,
  pnpm,
  systemctl,
  gh,
  ip: () => out(`${JSON.stringify([host().docker0])}\n`),
};
tools[tool]();
