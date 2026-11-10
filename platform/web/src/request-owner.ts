import { useEffect, useRef } from 'react';

interface Claim {
  signal: AbortSignal;
  /** True only while this claim still owns the page and was not aborted. */
  current: () => boolean;
  /** Clears the owner only when this claim is still current. */
  release: () => void;
}
interface RequestOwner {
  claim: () => Claim | null;
  busy: () => boolean;
}

/**
 * One page-level request owner shared by a page's loads and saves:
 * - first come, first served: `claim` refuses while another owner is in flight;
 * - unmount aborts the in-flight owner and clears it;
 * - a stale (aborted or released) claim reports `current() === false` and its `release` is a no-op,
 *   so its response never touches the page.
 * The returned object, `claim` and `busy` keep their identity across renders.
 */
export function useRequestOwner(): RequestOwner {
  const owner = useRef<AbortController | null>(null);
  const api = useRef<RequestOwner | null>(null);
  useEffect(
    () => () => {
      owner.current?.abort();
      owner.current = null;
    },
    [],
  );
  api.current ??= {
    claim: () => {
      if (owner.current !== null) return null;
      const controller = new AbortController();
      owner.current = controller;
      const current = () => owner.current === controller && !controller.signal.aborted;
      return {
        signal: controller.signal,
        current,
        release: () => {
          if (current()) owner.current = null;
        },
      };
    },
    busy: () => owner.current !== null,
  };
  return api.current;
}
