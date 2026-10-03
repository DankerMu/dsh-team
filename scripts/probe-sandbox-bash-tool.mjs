#!/usr/bin/env node
/**
 * In-container driver for task 1.2. Boots @deepseek-ai/dsh@0.2.0-rc.2 bash in
 * Workspace Write with no model. Plugins resolve from
 * /usr/local/lib/node_modules/@deepseek-ai/dsh/package.json.
 *
 * Release citations (npm tarballs, not resource/deepseek-harness):
 * - ctx.plugin: @deepseek-ai/cordis@4.0.4 registry.d.ts
 * - tools.execute({callId,name,arguments,signal}): dsh-tools 0.2.0-rc.2
 * - bash args description+command: dsh-tool-bash 0.2.0-rc.2
 * - sandbox-policy mode workspace-write: dsh-sandbox-policy 0.2.0-rc.2
 */
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
const fileExists = async (path) => {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
};
const readExact = async (path) => {
  try {
    return { ok: true, text: await readFile(path, 'utf8') };
  } catch (error) {
    return {
      ok: false,
      text: `UNREADABLE:${error instanceof Error ? error.message : String(error)}`,
    };
  }
};
const executeBash = (tools, callId, command, description) =>
  tools.execute({
    callId,
    name: 'bash',
    arguments: { description, command, timeoutMs: TOOL_TIMEOUT_MS },
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
  });

const main = async () => {
  const req = createRequire(ANCHOR);
  const mods = await Promise.all(PLUGINS.map((name) => load(req, name)));
  const ctx = new mods[0].Context();
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
  const statePresent = await fileExists(STATE_PATH);
  const wsOk =
    wsWrite.isError !== true &&
    contentText(wsWrite).includes('[exit code: 0]') &&
    disk.ok &&
    disk.text === WS_BODY &&
    wsRead.isError !== true &&
    contentText(wsRead).includes(WS_BODY.trim());
  const stateDenied = statePresent === false;
  const usable = wsOk && stateDenied;
  const reason = !wsOk
    ? `workspace write/read failed: ${errorText(wsWrite) || contentText(wsWrite) || disk.text}`
    : statePresent
      ? `state marker present at ${STATE_PATH} after bash write`
      : 'usable';
  out(`workspace ${JSON.stringify({ ...summarize(wsWrite), onDisk: disk.text, ok: wsOk })}`);
  out(
    `state ${JSON.stringify({ ...summarize(stateWrite), present: statePresent, denied: stateDenied })}`,
  );
  out(`PROBE_RESULT ${JSON.stringify({ usable, reason, wsOk, stateDenied, statePresent })}`);
};

main().catch((error) => {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  out(
    `PROBE_RESULT ${JSON.stringify({ usable: false, reason: `driver: ${message}${code ? ` code=${code}` : ''}` })}`,
  );
  process.exitCode = 2;
});
