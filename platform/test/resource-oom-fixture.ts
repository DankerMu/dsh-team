import type { DockerCommand, DockerCommandResult } from './docker-command.ts';
import type { UserImageLifecycle } from './user-image-fixture.ts';

const preparationScript = `
import json, os, pathlib, struct, sys
cgroup = pathlib.Path("/sys/fs/cgroup")
limits = {name: (cgroup / name).read_text().strip()
          for name in ["memory.max", "memory.swap.max", "pids.max"]}
if limits != {"memory.max": "268435456", "memory.swap.max": "0", "pids.max": "512"}:
    raise RuntimeError("Owned allocation cgroup limits differ from inspected settings")
events = dict((key, int(value)) for key, value in
              (line.split() for line in (cgroup / "memory.events").read_text().splitlines()))
proof = pathlib.Path("/data/work/.dsh-team-oom")
proof.mkdir(mode=0o700)
metadata = {"runId": sys.argv[1], "containerId": sys.argv[2],
            "requestedBytes": 536870912, "limits": limits,
            "oomKillBefore": events["oom_kill"]}
for name, content in [("metadata.json", json.dumps(metadata).encode()),
                      ("progress.bin", struct.pack("Q", 0))]:
    with (proof / name).open("xb") as target:
        target.write(content)
        target.flush()
        os.fsync(target.fileno())
`;

// Only the allocation child touches 512MiB. Progress survives loss of the whole
// 256MiB cgroup; SIGKILL/exit137 without the durable touch and OOM proof is rejected.
const pressureScript = `
import json, mmap, os, pathlib, signal, struct
proof = pathlib.Path("/data/work/.dsh-team-oom")
progress = os.open(proof / "progress.bin", os.O_RDWR)
signal.alarm(25)
pid = os.fork()
if pid == 0:
    signal.alarm(20)
    allocation = mmap.mmap(-1, 536870912)
    for offset in range(0, 536870912, 4096):
        allocation[offset] = 1
        if offset == 0 or (offset + 4096) % 1048576 == 0:
            os.pwrite(progress, struct.pack("Q", offset + 4096), 0)
            os.fsync(progress)
    os._exit(0)
_, status = os.waitpid(pid, 0)
signal.alarm(0)
events = dict((key, int(value)) for key, value in
              (line.split() for line in pathlib.Path("/sys/fs/cgroup/memory.events").read_text().splitlines()))
result = {"childSignal": os.WTERMSIG(status) if os.WIFSIGNALED(status) else 0,
          "oomKillAfter": events["oom_kill"]}
with (proof / "result.tmp").open("x") as target:
    json.dump(result, target)
    target.flush()
    os.fsync(target.fileno())
os.replace(proof / "result.tmp", proof / "result.json")
`;

const readScript = `
import json, pathlib, struct
proof = pathlib.Path("/data/work/.dsh-team-oom")
def document(name):
    with (proof / name).open("rb") as source:
        content = source.read(4097)
    if len(content) > 4096:
        raise RuntimeError("Oversized OOM proof")
    return json.loads(content)
result = document("metadata.json")
with (proof / "progress.bin").open("rb") as source:
    progress = source.read(9)
if len(progress) != 8:
    raise RuntimeError("Incomplete physical-touch proof")
result.update({"touchedBytes": struct.unpack("Q", progress)[0],
               "childSignal": None, "oomKillAfter": None})
if (proof / "result.json").is_file():
    result.update(document("result.json"))
print(json.dumps(result), flush=True)
`;

interface Identity {
  runId: string;
  containerId: string;
}
type Diagnostic = Record<string, number | boolean | null>;
type OomStage =
  | 'cgroup read'
  | 'pressure preflight'
  | 'pressure exec'
  | 'cgroup durable readback'
  | 'victim selection';
interface ResourceOomEvidence {
  requestedBytes: number;
  touchedBytes: number;
  oomKillBefore: number;
  oomKillAfter: number | null;
  childSignal: number | null;
  limits: { 'memory.max': string; 'memory.swap.max': string; 'pids.max': string };
  termination: 'child' | 'instance';
}

type OomValidator =
  | 'evidence-object'
  | 'counter'
  | 'pressure-completion'
  | 'live-instance'
  | 'proof-identity'
  | 'cgroup-limits'
  | 'physical-touch'
  | 'post-instance-identity'
  | 'instance-running'
  | 'instance-oom-flag'
  | 'instance-exit-code'
  | 'child-signal'
  | 'child-counter-missing'
  | 'child-counter-not-increased'
  | 'termination'
  | 'instance-wait'
  | 'external-operation';

class OomValidationError extends Error {
  readonly validator: OomValidator;
  constructor(validator: OomValidator, message: string) {
    super(message);
    this.validator = validator;
  }
}

interface OomStateSnapshot {
  phase: 'pre-pressure' | 'post-wait' | 'post-proof' | 'failure';
  atMs: number;
  available: boolean;
  running?: boolean;
  oomKilled?: boolean;
  exitCode?: number;
}
interface OomDockerEvent {
  action: 'oom' | 'die' | 'kill';
  timeNano: string;
  exitCode: number | null;
  signal: number | null;
}
interface OomEventCapture {
  phase: 'post-pressure' | 'post-proof';
  sinceMs: number;
  untilMs: number;
  result: 'complete' | 'command-error' | 'command-status' | 'oversized' | 'malformed';
  events: OomDockerEvent[];
}
interface OomTrace {
  runId?: string;
  containerId?: string;
  userId?: string;
  snapshots: OomStateSnapshot[];
  eventCaptures: OomEventCapture[];
  pressureStartedAtMs?: number;
  pressureFinishedAtMs?: number;
  failedValidator?: OomValidator;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new OomValidationError('evidence-object', 'Invalid OOM evidence object');
  // External Docker/proof JSON is narrowed field by field below.
  return value as Record<string, unknown>;
}

function counter(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new OomValidationError('counter', 'Invalid OOM evidence counter');
  return value;
}

function requirePressureCompletion(pressure: DockerCommandResult): void {
  if (pressure.error !== undefined) throw pressure.error;
  if (pressure.status !== 0 && pressure.status !== 137)
    throw new OomValidationError(
      'pressure-completion',
      'Owned OOM pressure failed or exceeded its deadline',
    );
}

function liveState(value: unknown, containerId: string): void {
  const container = record(value);
  const state = record(container.State);
  if (container.Id !== containerId || state.Running !== true || state.OOMKilled !== false)
    throw new OomValidationError(
      'live-instance',
      'OOM pressure requires the exact live instance without a prior OOM',
    );
}

function resourceOomDiagnostic(
  diagnostic: Record<string, number | boolean | null>,
  oom: Record<string, unknown>,
) {
  for (const key of [
    'requestedBytes',
    'touchedBytes',
    'childSignal',
    'oomKillBefore',
    'oomKillAfter',
  ]) {
    const value = oom[key];
    if (typeof value === 'number' && Number.isFinite(value)) diagnostic[`oom.${key}`] = value;
  }
  const limits = oom.limits;
  if (typeof limits !== 'object' || limits === null || Array.isArray(limits)) return;
  const cgroupLimits = record(limits);
  for (const key of ['memory.max', 'memory.swap.max', 'pids.max']) {
    const value = cgroupLimits[key];
    if (
      typeof value === 'string' &&
      /^\d{1,16}$/.test(value) &&
      Number.isSafeInteger(Number(value))
    )
      diagnostic[`cgroup.${key}`] = Number(value);
  }
}

/** Causal acceptance seam: exact identity, durable physical touch, and OOM-specific termination. */
export function validateResourceOomEvidence(
  value: unknown,
  identity: Identity,
  before: unknown,
  after: unknown,
  pressure: DockerCommandResult,
): ResourceOomEvidence {
  requirePressureCompletion(pressure);
  liveState(before, identity.containerId);
  const proof = record(value);
  if (proof.runId !== identity.runId || proof.containerId !== identity.containerId)
    throw new OomValidationError(
      'proof-identity',
      'OOM proof belongs to a different invocation or instance',
    );
  const limits = record(proof.limits);
  if (
    limits['memory.max'] !== '268435456' ||
    limits['memory.swap.max'] !== '0' ||
    limits['pids.max'] !== '512'
  )
    throw new OomValidationError(
      'cgroup-limits',
      'OOM proof does not show the required cgroup limits',
    );
  const touchedBytes = counter(proof.touchedBytes);
  if (
    proof.requestedBytes !== 536_870_912 ||
    touchedBytes === 0 ||
    touchedBytes >= 536_870_912 ||
    touchedBytes % 4096 !== 0
  )
    throw new OomValidationError(
      'physical-touch',
      'Missing bounded physical-touch evidence for the 512MiB allocation',
    );
  const oomKillBefore = counter(proof.oomKillBefore);
  const container = record(after);
  if (container.Id !== identity.containerId)
    throw new OomValidationError('post-instance-identity', 'OOM state belongs to another instance');
  const state = record(container.State);
  const childSignal = proof.childSignal === null ? null : counter(proof.childSignal);
  const oomKillAfter = proof.oomKillAfter === null ? null : counter(proof.oomKillAfter);
  const evidence = {
    requestedBytes: 536_870_912,
    touchedBytes,
    oomKillBefore,
    oomKillAfter,
    childSignal,
    limits: { 'memory.max': '268435456', 'memory.swap.max': '0', 'pids.max': '512' },
  };
  return classifyTermination(evidence, state, pressure.status);
}

function classifyTermination(
  evidence: Omit<ResourceOomEvidence, 'termination'>,
  state: Record<string, unknown>,
  status: number | null,
): ResourceOomEvidence {
  if (
    status === 0 &&
    evidence.childSignal === 9 &&
    evidence.oomKillAfter !== null &&
    evidence.oomKillAfter > evidence.oomKillBefore
  )
    return { ...evidence, termination: 'child' };
  if (
    status === 137 &&
    state.Running === false &&
    state.OOMKilled === true &&
    state.ExitCode === 137
  )
    return { ...evidence, termination: 'instance' };
  throw new OomValidationError(
    terminationValidator(evidence, state, status),
    'Missing OOM-specific abnormal child or instance termination',
  );
}

function terminationValidator(
  evidence: Omit<ResourceOomEvidence, 'termination'>,
  state: Record<string, unknown>,
  status: number | null,
): OomValidator {
  if (status === 137) {
    if (state.Running !== false) return 'instance-running';
    if (state.OOMKilled !== true) return 'instance-oom-flag';
    if (state.ExitCode !== 137) return 'instance-exit-code';
  }
  if (status === 0) {
    if (evidence.childSignal !== 9) return 'child-signal';
    if (evidence.oomKillAfter === null) return 'child-counter-missing';
    if (evidence.oomKillAfter <= evidence.oomKillBefore) return 'child-counter-not-increased';
  }
  return 'termination';
}

function output(command: DockerCommand, args: readonly string[], timeout: number): string {
  const result = command(args, timeout);
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error('Independent OOM proof operation failed');
  return result.stdout;
}

function inspect(
  command: DockerCommand,
  kind: 'container' | 'volume',
  name: string,
): Record<string, unknown> {
  const rows: unknown = JSON.parse(output(command, [kind, 'inspect', name], 15_000));
  if (!Array.isArray(rows) || rows.length !== 1)
    throw new Error('Missing exact OOM proof resource');
  return record(rows[0]);
}

function readProof(lifecycle: UserImageLifecycle, userId: string): unknown {
  const volume = `dsh-team-work-${userId}`;
  const ownedVolume = inspect(lifecycle.command, 'volume', volume);
  if (ownedVolume.Name !== volume || record(ownedVolume.Labels)['dsh-team.user'] !== userId)
    throw new Error('Refusing unowned OOM proof volume');
  const name = `dsh-team-oom-${lifecycle.runId}`;
  const labels = {
    'dsh-team.user': userId,
    'dsh-team.invocation': lifecycle.runId,
    'dsh-team.role': 'oom-proof-reader',
  };
  lifecycle.registerResource('container', name, labels);
  const args = [
    'create',
    '--name',
    name,
    '--network',
    'none',
    '--user',
    '1001',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--security-opt',
    `seccomp=${lifecycle.seccomp}`,
    '--mount',
    `type=volume,source=${volume},target=/data/work,readonly`,
  ];
  for (const [key, value] of Object.entries(labels)) args.push('--label', `${key}=${value}`);
  args.push(lifecycle.imageId, 'python3', '-c', readScript);
  output(lifecycle.command, args, 15_000);
  verifyReader(inspect(lifecycle.command, 'container', name), lifecycle, volume, labels);
  // A separate offline helper survives B's cgroup; its attach/read is still bounded.
  const proof = output(lifecycle.command, ['start', '--attach', name], 15_000);
  if (output(lifecycle.command, ['wait', name], 5_000).trim() !== '0')
    throw new Error('Owned OOM proof reader failed');
  const document: unknown = JSON.parse(proof);
  return document;
}

function verifyReader(
  container: Record<string, unknown>,
  lifecycle: UserImageLifecycle,
  volume: string,
  labels: Record<string, string>,
): void {
  const config = record(container.Config);
  const host = record(container.HostConfig);
  if (
    container.Image !== lifecycle.imageId ||
    config.User !== '1001' ||
    host.NetworkMode !== 'none' ||
    host.ReadonlyRootfs !== true
  )
    throw new Error('OOM reader requires the captured offline non-root image');
  const actualLabels = record(config.Labels);
  for (const [key, value] of Object.entries(labels)) {
    if (actualLabels[key] !== value) throw new Error('OOM reader ownership differs');
  }
  const env = config.Env;
  if (
    !Array.isArray(env) ||
    env.some((value: unknown) => typeof value !== 'string' || value.startsWith('DMXAPI_KEY='))
  )
    throw new Error('OOM reader must be credential-free');
  const mounts = container.Mounts;
  if (!Array.isArray(mounts) || mounts.length !== 1)
    throw new Error('OOM reader must mount only its owned work volume');
  const mount = record(mounts[0]);
  if (
    mount.Type !== 'volume' ||
    mount.Name !== volume ||
    mount.Destination !== '/data/work' ||
    mount.RW !== false
  )
    throw new Error('OOM reader work volume must be exact and read-only');
}

function stateSnapshot(
  trace: OomTrace,
  lifecycle: UserImageLifecycle,
  containerId: string,
  phase: OomStateSnapshot['phase'],
  observed?: unknown,
): void {
  const snapshot: OomStateSnapshot = { phase, atMs: Date.now(), available: false };
  try {
    const container =
      observed === undefined
        ? inspect(lifecycle.command, 'container', containerId)
        : record(observed);
    if (container.Id !== containerId) throw new Error();
    const state = record(container.State);
    snapshot.available = true;
    if (typeof state.Running === 'boolean') snapshot.running = state.Running;
    if (typeof state.OOMKilled === 'boolean') snapshot.oomKilled = state.OOMKilled;
    if (typeof state.ExitCode === 'number' && Number.isSafeInteger(state.ExitCode))
      snapshot.exitCode = state.ExitCode;
  } catch {
    // A diagnostic inspect failure must not replace the original acceptance result.
  }
  trace.snapshots.push(snapshot);
}

function eventNumber(value: unknown, maximum: number): number | null {
  if (value === 'SIGKILL') return 9;
  if (value === 'SIGTERM') return 15;
  if (typeof value !== 'string' || !/^\d{1,3}$/.test(value)) return null;
  const number = Number(value);
  return number <= maximum ? number : null;
}

function projectedEvent(line: string, containerId: string): OomDockerEvent {
  const event = record(JSON.parse(line));
  if (
    event.containerId !== containerId ||
    (event.action !== 'oom' && event.action !== 'die' && event.action !== 'kill') ||
    typeof event.timeNano !== 'string' ||
    !/^\d{1,20}$/.test(event.timeNano)
  )
    throw new Error();
  return {
    action: event.action,
    timeNano: event.timeNano,
    exitCode: eventNumber(event.exitCode, 255),
    signal: eventNumber(event.signal, 64),
  };
}

function captureOomEvents(
  trace: OomTrace,
  lifecycle: UserImageLifecycle,
  sinceMs: number,
  phase: OomEventCapture['phase'],
): void {
  const capture: OomEventCapture = {
    phase,
    sinceMs,
    untilMs: Date.now(),
    result: 'command-error',
    events: [],
  };
  try {
    const id = trace.containerId;
    if (id === undefined) throw new Error();
    // Project at the Docker boundary: do not even fetch labels, environment or arbitrary attributes.
    const format =
      '{"containerId":{{json .Actor.ID}},"action":{{json .Action}},"timeNano":"{{.TimeNano}}","exitCode":{{json (index .Actor.Attributes "exitCode")}},"signal":{{json (index .Actor.Attributes "signal")}}}';
    const result = lifecycle.command(
      [
        'events',
        '--since',
        new Date(sinceMs).toISOString(),
        '--until',
        new Date(capture.untilMs).toISOString(),
        '--filter',
        'type=container',
        '--filter',
        `container=${id}`,
        '--filter',
        'event=oom',
        '--filter',
        'event=die',
        '--filter',
        'event=kill',
        '--format',
        format,
      ],
      5000,
    );
    if (result.error !== undefined) throw new Error();
    if (result.status !== 0) {
      capture.result = 'command-status';
      return;
    }
    // Docker retains only a finite event history; collect immediately, with our own smaller byte/row cap.
    if (Buffer.byteLength(result.stdout) > 16 * 1024) {
      capture.result = 'oversized';
      return;
    }
    const lines = result.stdout.split(/\r?\n/).filter((line) => line !== '');
    if (lines.length > 32) {
      capture.result = 'oversized';
      return;
    }
    capture.result = 'malformed';
    const events = lines.map((line) => projectedEvent(line, id));
    capture.events = events;
    capture.result = 'complete';
  } catch {
    // Event collection is diagnostic only; no output/error bytes survive this boundary.
  } finally {
    trace.eventCaptures.push(capture);
  }
}

function recordTraceIdentity(
  trace: OomTrace,
  lifecycle: UserImageLifecycle,
  userId: string,
  containerId: string,
  before: Record<string, unknown>,
): void {
  if (/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(lifecycle.runId))
    trace.runId = lifecycle.runId;
  if (/^[a-z0-9]{12}$/.test(userId)) trace.userId = userId;
  try {
    if (
      /^[a-f0-9]{64}$/.test(containerId) &&
      before.Id === containerId &&
      record(record(before.Config).Labels)['dsh-team.user'] === userId
    )
      trace.containerId = containerId;
  } catch {
    // Missing ownership metadata omits diagnostic identity; it cannot alter acceptance.
  }
}

/** Host-owned bounded observer; B is never required to survive its own OOM. */
export function observeResourceOom(
  lifecycle: UserImageLifecycle,
  containerId: string,
  userId: string,
  diagnostic: Diagnostic,
  setStage: (stage: OomStage) => void,
): ResourceOomEvidence {
  const trace: OomTrace = { snapshots: [], eventCaptures: [] };
  try {
    setStage('cgroup read');
    output(
      lifecycle.command,
      [
        'exec',
        '--user',
        '1001',
        containerId,
        'python3',
        '-c',
        preparationScript,
        lifecycle.runId,
        containerId,
      ],
      15_000,
    );
    setStage('pressure preflight');
    const before = inspect(lifecycle.command, 'container', containerId);
    liveState(before, containerId);
    recordTraceIdentity(trace, lifecycle, userId, containerId, before);
    stateSnapshot(trace, lifecycle, containerId, 'pre-pressure', before);
    setStage('pressure exec');
    const pressureStartedAt = Date.now();
    trace.pressureStartedAtMs = pressureStartedAt;
    const pressure = lifecycle.command(
      ['exec', '--user', '1001', containerId, 'python3', '-c', pressureScript],
      30_000,
    );
    diagnostic['pressure.status'] = pressure.status;
    diagnostic['pressure.commandError'] = pressure.error !== undefined;
    trace.pressureFinishedAtMs = Date.now();
    requirePressureCompletion(pressure);
    setStage('victim selection');
    // Keep the original wait and acceptance snapshot; later snapshots are evidence only, never retries.
    if (
      pressure.status === 137 &&
      output(lifecycle.command, ['wait', containerId], 5_000).trim() !== '137'
    )
      throw new OomValidationError(
        'instance-wait',
        'OOM pressure did not terminate the exact instance',
      );
    const after = inspect(lifecycle.command, 'container', containerId);
    stateSnapshot(trace, lifecycle, containerId, 'post-wait', after);
    captureOomEvents(trace, lifecycle, pressureStartedAt, 'post-pressure');
    const state = record(after.State);
    for (const key of ['Running', 'OOMKilled', 'ExitCode']) {
      const value = state[key];
      if (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))
        diagnostic[`B.postPressure.${key}`] = value;
    }
    setStage('cgroup durable readback');
    const proof = readProof(lifecycle, userId);
    resourceOomDiagnostic(diagnostic, record(proof));
    stateSnapshot(trace, lifecycle, containerId, 'post-proof');
    captureOomEvents(trace, lifecycle, pressureStartedAt, 'post-proof');
    setStage('victim selection');
    return validateResourceOomEvidence(
      proof,
      { runId: lifecycle.runId, containerId },
      before,
      after,
      pressure,
    );
  } catch (error) {
    trace.failedValidator =
      error instanceof OomValidationError ? error.validator : 'external-operation';
    stateSnapshot(trace, lifecycle, containerId, 'failure');
    throw error;
  } finally {
    process.stdout.write(`[DEBUG-issue38-oom] ${JSON.stringify(trace)}\n`);
  }
}
