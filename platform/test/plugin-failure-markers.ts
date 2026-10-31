/**
 * dsh-app-boot 0.2.1 (`lib/index.js`) diagnostics, matched as substrings rather than line prefixes,
 * that mean a delivered plugin did not load although the instance may still boot:
 * - `Failed plugins (` (:4435) and `plugin tree failed to load` (:4537): startup failure report;
 * - `dsh: skipping profile bundle` (:538) and `dsh: disabling profile plugin` (:2308): skips;
 * - `did not activate` (:4410): a failed or pending entry outside `requiredStartupEntryIds` is only
 *   warned about, as `${binName}: warning: ${N} ${noun} did not activate`, and DSH keeps booting.
 */
const PLUGIN_FAILURE_MARKERS = [
  'Failed plugins (',
  'plugin tree failed to load',
  'dsh: skipping profile bundle',
  'dsh: disabling profile plugin',
  'did not activate',
];

/** Logs carry the launch token: they are judged in memory and only the matched marker leaves. */
export function rejectPluginFailures(logs: { stdout: string; stderr: string }, message: string) {
  for (const marker of PLUGIN_FAILURE_MARKERS) {
    if (logs.stdout.includes(marker) || logs.stderr.includes(marker))
      throw new Error(`${message}: ${marker}`);
  }
}
