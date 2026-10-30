/**
 * In-container readiness poll for the deployed local model stub. A refused or unanswered
 * `/health` request is the stub's normal not-yet-listening state, so retries stay inside the
 * one exec; every fetch is bounded by the remaining deadline. Exits 1 with `{"ready":false}`
 * when the deadline passes.
 */
export function localModelReadyScript(
  origin = 'http://127.0.0.1:3099',
  deadlineMs = 10_000,
): string {
  return [
    'let ready = false;',
    `const deadline = performance.now() + ${String(deadlineMs)};`,
    'while (performance.now() < deadline) {',
    '  const remaining = Math.max(1, Math.ceil(deadline - performance.now()));',
    '  try {',
    `    const r = await fetch(${JSON.stringify(`${origin}/health`)}, { signal: AbortSignal.timeout(remaining) });`,
    '    const body = await r.json();',
    '    if (body && body.ready === true) { ready = true; break; }',
    '  } catch {}',
    '  await new Promise((r) => setTimeout(r, 100));',
    '}',
    'process.stdout.write(JSON.stringify({ ready }));',
    'process.exitCode = ready ? 0 : 1;',
  ].join('\n');
}

export const LOCAL_MODEL_READY_SCRIPT = localModelReadyScript();

/**
 * Issues exactly one readiness exec. A rejected read (nonzero exec, including the timeout exit)
 * propagates unchanged: a mutating `docker exec` must settle, never be retried host-side.
 */
export async function awaitLocalModelReady(
  read: (script: string) => Promise<Record<string, unknown>>,
): Promise<void> {
  const result = await read(LOCAL_MODEL_READY_SCRIPT);
  if (result.ready !== true) throw new Error('Local model stub not ready');
}
