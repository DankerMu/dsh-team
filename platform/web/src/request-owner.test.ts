// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useRequestOwner } from './request-owner.ts';

type Owner = ReturnType<typeof useRequestOwner>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});
afterEach(() => {
  try {
    if (root !== null) {
      const mounted = root;
      act(() => {
        mounted.unmount();
      });
    }
  } finally {
    container?.remove();
    root = null;
    container = null;
    vi.unstubAllGlobals();
  }
});

/** Renders a component that records the hook's result on every render. */
function mount(): { seen: Owner[]; rerender: () => void; unmount: () => void } {
  const seen: Owner[] = [];
  function Probe() {
    seen.push(useRequestOwner());
    return null;
  }
  const view = document.createElement('div');
  document.body.append(view);
  const created = createRoot(view);
  root = created;
  container = view;
  act(() => {
    created.render(createElement(Probe));
  });
  return {
    seen,
    rerender: () => {
      act(() => {
        created.render(createElement(Probe));
      });
    },
    unmount: () => {
      act(() => {
        created.unmount();
      });
      root = null;
    },
  };
}

function first(seen: Owner[]): Owner {
  const owner = seen[0];
  if (owner === undefined) throw new Error('The probe never rendered');
  return owner;
}

it('refuses a claim while another owner is in flight', () => {
  const owner = first(mount().seen);

  const held = owner.claim();
  const refused = owner.claim();

  expect(held).not.toBeNull();
  expect(held?.current()).toBe(true);
  expect(refused).toBeNull();
});

it('accepts a new claim after the owner releases', () => {
  const owner = first(mount().seen);
  const held = owner.claim();

  held?.release();
  const next = owner.claim();

  expect(held?.current()).toBe(false);
  expect(next).not.toBeNull();
  expect(next?.current()).toBe(true);
});

it('reports busy from claim until release', () => {
  const owner = first(mount().seen);
  const idle = owner.busy();

  const held = owner.claim();
  const claimed = owner.busy();
  held?.release();

  expect([idle, claimed, owner.busy()]).toEqual([false, true, false]);
});

it('aborts the in-flight owner on unmount', () => {
  const view = mount();
  const owner = first(view.seen);
  const held = owner.claim();

  view.unmount();

  expect(held?.signal.aborted).toBe(true);
  expect(held?.current()).toBe(false);
  expect(owner.busy()).toBe(false);
});

it('unmounts without an owner and leaves nothing claimed', () => {
  const view = mount();
  const owner = first(view.seen);

  view.unmount();

  expect(owner.busy()).toBe(false);
});

it('never lets an aborted owner release a later owner', () => {
  const view = mount();
  const owner = first(view.seen);
  const aborted = owner.claim();
  view.unmount();
  const later = owner.claim();

  aborted?.release();

  expect(aborted?.current()).toBe(false);
  expect(later?.current()).toBe(true);
  expect(owner.busy()).toBe(true);
});

it('never lets a released owner release a later owner', () => {
  const owner = first(mount().seen);
  const released = owner.claim();
  released?.release();
  const later = owner.claim();

  released?.release();

  expect(later?.current()).toBe(true);
  expect(owner.busy()).toBe(true);
});

it('keeps the same owner, claim and busy across renders', () => {
  const view = mount();

  view.rerender();
  const [before, after] = view.seen;

  expect(view.seen).toHaveLength(2);
  expect(after).toBe(before);
  expect(after?.claim).toBe(before?.claim);
  expect(after?.busy).toBe(before?.busy);
});
