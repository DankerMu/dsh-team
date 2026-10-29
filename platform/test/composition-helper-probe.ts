import { setTimeout as delay } from 'node:timers/promises';
import { record } from './docker-cleanup.ts';

interface CompositionHelperProbe {
  readonly inspect: (id: string) => Promise<Record<string, unknown>>;
  readonly exec: (args: string[]) => Promise<string>;
}

const WAIT_FOR_PARTNER = 'wait_for_partner';

/**
 * Waits until the composition helper's PID 1 is blocked in its vfork partner wait.
 * Running precedes the wait, so the wchan value is re-observed between successful execs.
 */
export async function awaitHelperWaitingForPartner(
  probe: CompositionHelperProbe,
  id: string,
  deadlineMs = 10_000,
  intervalMs = 50,
): Promise<void> {
  const deadline = performance.now() + deadlineMs;
  for (;;) {
    // Any inspect/exec rejection propagates: a mutating exec must settle, never be retried.
    const running = record((await probe.inspect(id)).State).Running === true;
    let wchan: string | undefined;
    if (running) {
      wchan = (await probe.exec(['exec', id, 'cat', '/proc/1/wchan'])).trim();
      if (wchan === WAIT_FOR_PARTNER) return;
    }
    if (performance.now() >= deadline) {
      throw new Error(
        `Composition helper did not reach ${WAIT_FOR_PARTNER} (running=${String(running)} wchan=${wchan ?? 'none'})`,
      );
    }
    await delay(intervalMs);
  }
}
