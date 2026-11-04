// @vitest-environment jsdom
/* global window */
import { expect, it, vi } from 'vitest';

const loads = [];
window.__ModuleLoader__ = { load: (registration) => loads.push(registration) };
const fetchSpy = vi.fn();
vi.stubGlobal('fetch', fetchSpy);
const consoleSpies = ['log', 'info', 'warn', 'error', 'debug'].map((method) =>
  vi.spyOn(console, method),
);
await import('./client.js');
Reflect.deleteProperty(window, '__ModuleLoader__');

it('loads exactly one classic-script registration under the package id', () => {
  expect(loads).toHaveLength(1);
  expect(loads[0].id).toBe('@dsh-team/knowledge-base');
  expect(Object.keys(loads[0])).toEqual(['id', 'factory']);
});

it('injects no service, registers no slot and sends no request', () => {
  const requireClient = vi.fn();
  const plugin = loads[0].factory(requireClient);
  const slots = { inject: vi.fn(), register: vi.fn() };

  expect(plugin.inject).toEqual([]);
  expect(plugin.apply({ slots })).toBeUndefined();

  expect(requireClient).not.toHaveBeenCalled();
  expect(slots.inject).not.toHaveBeenCalled();
  expect(slots.register).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  expect(window.document.head.childElementCount).toBe(0);
  expect(window.document.body.childElementCount).toBe(0);
});
