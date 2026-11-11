// @ts-check
/**
 * Host half of the Office hints plugin. It has nothing to do: the managed overlay's host row loads
 * the client half through the manifest's `dsh.client`, and no page global is published.
 */
export const name = 'dsh-team-office-hints';

/** @type {import('./types.js').OfficeHintsHostApply} */
export function apply() {
  // Intentionally empty: every behavior lives in the client half around the ONLYOFFICE viewers.
}
