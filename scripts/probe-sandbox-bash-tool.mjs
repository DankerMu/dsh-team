#!/usr/bin/env node
/** In-container driver for task 1.2. ctx.fiber.dispose(); no '[exit code: 0]'. */
import { createRequire } from 'node:module';
import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ANCHOR = '/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json';
const WORKSPACE = '/data/work';
const HOME = '/data/home';
const WS_PATH = `${WORKSPACE}/dsh-team-probe-ws.txt`;
const STATE_PATH = `${HOME}/dsh-team-probe-state.txt`;
const WS_BODY = 'dsh-team-ws\n';
const STATE_BODY = 'dsh-team-state\n';
const TOOL_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 30_000;
const PLUGINS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-subprocess-local',
  '@deepseek-ai/dsh-sandbox-local',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-bash-sandbox',
  '@deepseek-ai/dsh-shell-env',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-tool-bash',
];

const out = (line) => process.stdout.write(`${line}\n`);
const load = (req, specifier) => import(pathToFileURL(req.resolve(specifier)).href);
const contentText = (result) =>
  (Array.isArray(result?.content) ? result.content : [])
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .join('');
const errorText = (result) => {
  const info = result?.error?.info;
  return [result?.error?.message, contentText(result), info?.code, info?.reason]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join('\n');
};
const summarize = (result) =>
  result?.isError === true
    ? { isError: true, text: errorText(result).slice(0, 800) }
    : { isError: false, text: contentText(result).slice(0, 800) };
const probeText = (result) => [errorText(result), contentText(result)].filter(Boolean).join('\n');
const errDetail = (error) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  return `${message}${code ? ` code=${code}` : ''}`;
};
const readExact = async (path) => {
  try {
    return { ok: true, text: await readFile(path, 'utf8') };
  } catch (error) {
    return { ok: false, text: `UNREADABLE:${errDetail(error)}` };
  }
};
const statePresence = async (path) => {
  try {
    await access(path, fsConstants.F_OK);
    return { present: true };
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return { present: false };
    return { present: null, detail: errDetail(error) };
  }
};
const executeBash = (tools, callId, command, description) =>
  tools.execute({
    callId,
    name: 'bash',
    arguments: { description, command, timeoutMs: TOOL_TIMEOUT_MS },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });
const failResult = (reason) => ({
  usable: false,
  reason,
  wsOk: false,
  stateDenied: false,
  statePresent: null,
});
const classify = (wsWrite, wsRead, disk, stateWrite, presence, denialMarker) => {
  const wsFailed = [];
  if (wsWrite.isError === true) wsFailed.push('workspace write isError');
  if (!disk.ok) wsFailed.push(`workspace disk unreadable (${disk.text})`);
  else if (disk.text !== WS_BODY) wsFailed.push('workspace disk bytes mismatch');
  if (wsRead.isError === true) wsFailed.push('workspace read isError');
  else if (!contentText(wsRead).includes(WS_BODY.trim())) {
    wsFailed.push('workspace tool read missing marker');
  }
  const wsOk = wsFailed.length === 0;
  const stateDenied = probeText(stateWrite).includes(denialMarker) && presence.present === false;
  const usable = wsOk && stateDenied;
  let reason = `state write lacked sandbox denial marker ${denialMarker}`;
  if (!wsOk) reason = `workspace write/read failed: ${wsFailed.join('; ')}`;
  else if (presence.present === true) {
    reason = `state marker present at ${STATE_PATH} after bash write`;
  } else if (presence.present === null) {
    reason = `state marker access indeterminate: ${presence.detail}`;
  } else if (stateDenied) {
    reason = 'usable';
  }
  return { usable, reason, wsOk, stateDenied, statePresent: presence.present };
};
const emit = (result, exitCode) => {
  out(`PROBE_RESULT ${JSON.stringify(result)}`);
  process.exitCode = exitCode;
};

const main = async () => {
  const req = createRequire(ANCHOR);
  const mods = await Promise.all(PLUGINS.map((name) => load(req, name)));
  const ctx = new mods[0].Context();
  let result = failResult('driver: no result');
  try {
    await ctx.plugin(mods[1].default);
    await ctx.plugin(mods[2].default);
    await ctx.plugin(mods[3].default);
    await ctx.plugin(mods[4].default);
    await ctx.plugin(mods[5].default, { mode: 'workspace-write', workspaceRoot: WORKSPACE });
    await ctx.plugin(mods[6].default, { cwd: WORKSPACE, timeoutMs: TOOL_TIMEOUT_MS });
    await ctx.plugin(mods[7], { dshHome: HOME });
    await ctx.plugin(mods[8].default);
    await ctx.plugin(mods[9], { enableRunInBackground: false, promoteOnTimeout: false });
    if (typeof ctx.sandboxPolicy?.resolve !== 'function') {
      throw new Error('ctx.sandboxPolicy.resolve is missing after plugin boot');
    }
    const policy = ctx.sandboxPolicy.resolve();
    out(`policy mode=${policy.mode} workspaceRoot=${policy.workspaceRoot}`);
    const denialMarker = `[sandbox: file access denied under ${policy.mode} mode]`;
    const wsWrite = await executeBash(
      ctx.tools,
      'probe-ws-write',
      `printf '${WS_BODY}' > '${WS_PATH}'`,
      'Write workspace probe marker',
    );
    const wsRead = await executeBash(
      ctx.tools,
      'probe-ws-read',
      `cat '${WS_PATH}'`,
      'Read workspace probe marker',
    );
    const disk = await readExact(WS_PATH);
    const stateWrite = await executeBash(
      ctx.tools,
      'probe-state-write',
      `printf '${STATE_BODY}' > '${STATE_PATH}'`,
      'Write state directory probe marker',
    );
    const presence = await statePresence(STATE_PATH);
    result = classify(wsWrite, wsRead, disk, stateWrite, presence, denialMarker);
    out(
      'workspace ' + JSON.stringify({ ...summarize(wsWrite), onDisk: disk.text, ok: result.wsOk }),
    );
    const stateView = {
      ...summarize(stateWrite),
      present: presence.present,
      denied: result.stateDenied,
    };
    out('state ' + JSON.stringify(stateView));
  } catch (error) {
    result = failResult(`driver: ${errDetail(error)}`);
  } finally {
    try {
      await ctx.fiber.dispose();
    } catch (error) {
      if (result.usable) result = failResult(`context dispose failed: ${errDetail(error)}`);
    }
  }
  emit(result, result.usable ? 0 : 1);
};

main().catch((error) => emit(failResult(`driver: ${errDetail(error)}`), 2));
