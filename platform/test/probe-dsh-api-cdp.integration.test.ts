import { afterEach, expect, it, vi } from 'vitest';
import { connectPage } from '../../scripts/probe-dsh-api-cdp.mjs';

interface Listener {
  handler: (event: { data?: string }) => void;
  once: boolean;
}
interface Envelope {
  id: number;
  method: string;
  params: unknown;
  sessionId?: string;
}

/** A browser endpoint that answers every command and records each envelope it was sent. */
class BrowserSocket {
  static current: BrowserSocket;
  readyState = 1;
  readonly sent: Envelope[] = [];
  readonly listeners = new Map<string, Set<Listener>>();
  constructor() {
    BrowserSocket.current = this;
    queueMicrotask(() => {
      this.dispatch('open', {});
    });
  }
  addEventListener(name: string, handler: Listener['handler'], options?: { once?: boolean }) {
    const listeners = this.listeners.get(name) ?? new Set<Listener>();
    this.listeners.set(name, listeners);
    listeners.add({ handler, once: options?.once === true });
  }
  dispatch(name: string, event: { data?: string }) {
    for (const listener of this.listeners.get(name) ?? []) {
      if (listener.once) this.listeners.get(name)?.delete(listener);
      listener.handler(event);
    }
  }
  event(sessionId: string | undefined, method: string, params: unknown) {
    this.dispatch('message', { data: JSON.stringify({ sessionId, method, params }) });
  }
  send(data: string) {
    const command = JSON.parse(data) as Envelope;
    this.sent.push(command);
    const result =
      command.method === 'Target.createTarget'
        ? { targetId: 'target-page' }
        : command.method === 'Target.attachToTarget'
          ? { sessionId: 'session-page' }
          : { echoed: command.method };
    this.dispatch('message', { data: JSON.stringify({ id: command.id, result }) });
  }
  close() {
    this.readyState = 3;
    this.dispatch('close', {});
  }
}
afterEach(() => vi.unstubAllGlobals());

async function page() {
  vi.stubGlobal('WebSocket', BrowserSocket);
  return connectPage('ws://127.0.0.1:12345/devtools/browser/owned');
}

it('keeps `on` a single replaceable handler per session and method', async () => {
  const target = await page();
  const seen: string[] = [];
  target.on('Page.loadEventFired', () => seen.push('first'));
  target.on('Page.loadEventFired', () => seen.push('second'));

  BrowserSocket.current.event('session-page', 'Page.loadEventFired', {});

  expect(seen).toEqual(['second']);
  target.close();
});

it('fans one event out to every listener beside the `on` handler until each unsubscribes', async () => {
  const target = await page();
  const seen: string[] = [];
  target.on('Log.entryAdded', () => seen.push('on'));
  const stopA = target.listen('Log.entryAdded', (params) => seen.push(`a:${String(params.n)}`));
  target.listen('Log.entryAdded', (params) => seen.push(`b:${String(params.n)}`));

  BrowserSocket.current.event('session-page', 'Log.entryAdded', { n: 1 });
  stopA();
  BrowserSocket.current.event('session-page', 'Log.entryAdded', { n: 2 });

  expect(seen).toEqual(['on', 'a:1', 'b:1', 'on', 'b:2']);
  target.close();
});

it('sends and listens on a child session without touching the page session', async () => {
  const target = await page();
  const child = target.session('session-child');
  const pageEvents: unknown[] = [];
  const childEvents: unknown[] = [];
  target.listen('Network.responseReceived', (params) => pageEvents.push(params));
  child.listen('Network.responseReceived', (params) => childEvents.push(params));
  child.on('Network.requestWillBeSent', (params) => childEvents.push(params));

  expect(target.sessionId).toBe('session-page');
  expect(child.sessionId).toBe('session-child');
  expect(await child.send('Runtime.runIfWaitingForDebugger')).toEqual({
    echoed: 'Runtime.runIfWaitingForDebugger',
  });
  expect(await target.send('Page.enable')).toEqual({ echoed: 'Page.enable' });
  BrowserSocket.current.event('session-child', 'Network.responseReceived', { r: 'child' });
  BrowserSocket.current.event('session-child', 'Network.requestWillBeSent', { q: 'child' });
  BrowserSocket.current.event('session-page', 'Network.responseReceived', { r: 'page' });
  BrowserSocket.current.event(undefined, 'Network.responseReceived', { r: 'browser' });

  const sent = BrowserSocket.current.sent.slice(2);
  expect(sent.map(({ method, sessionId }) => ({ method, sessionId }))).toEqual([
    { method: 'Runtime.runIfWaitingForDebugger', sessionId: 'session-child' },
    { method: 'Page.enable', sessionId: 'session-page' },
  ]);
  expect(childEvents).toEqual([{ r: 'child' }, { q: 'child' }]);
  expect(pageEvents).toEqual([{ r: 'page' }]);
  target.close();
});
