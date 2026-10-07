import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { captureModelRefusal } from '../../scripts/probe-model-refusal.mjs';

it('retains admitted prompt identities when UI, screenshot and subsequent enrichment fail before Chrome cleanup', async () => {
  const work = mkdtempSync(join(tmpdir(), 'dsh-team-refusal-browser-'));
  const bin = join(work, 'chrome');
  const stopped = join(work, 'stopped');
  const receipt = join(work, 'receipt.json');
  const screenshot = join(work, 'session-error.png');
  const boundary: string[] = [];
  const roster = [
    '@deepseek-ai/dsh-client-ui-model-selection',
    '@deepseek-ai/dsh-client-ui-settings-general',
    '@dsh-team/zh-locale',
  ];
  // The real Chrome launcher owns this child/listener and must stop it on rejection.
  writeFileSync(
    bin,
    `#!/usr/bin/env node
const http = require('node:http');
const fs = require('node:fs');
const port = Number(process.argv.find(arg => arg.startsWith('--remote-debugging-port=')).split('=')[1]);
const server = http.createServer((req, res) => {
  if (req.url !== '/json/version') { res.writeHead(404); res.end(); return; }
  res.end(JSON.stringify({ webSocketDebuggerUrl: 'ws://127.0.0.1:' + port + '/devtools/browser/owned' }));
});
server.listen(port, '127.0.0.1');
process.once('SIGTERM', () => {
  fs.writeFileSync(${JSON.stringify(stopped)}, 'SIGTERM');
  server.close(() => process.exit(0));
});
`,
    { mode: 0o755 },
  );

  // Fake only the external CDP WebSocket. All project driver/helpers execute normally.
  class RefusalSocket extends EventTarget {
    readyState = 1;

    constructor() {
      super();
      queueMicrotask(() => this.dispatchEvent(new Event('open')));
    }

    frame(value: unknown): void {
      this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(value) }));
    }

    event(method: string, params: unknown): void {
      this.frame({ sessionId: 'cdp-owned', method, params });
    }

    evaluate(id: number, expression = ''): void {
      let value: unknown;
      if (expression.includes('window.__DSH_BOOT__')) {
        value = {
          rev: 'boot-owned',
          entries: roster.map((id) => ({ id, rev: 'owned', url: '/owned' })),
        };
      } else if (expression.includes('const noticeLabels=')) {
        value = {
          chromeReady: true,
          notice: false,
          composerPresent: true,
          workspaceSelected: true,
          editable: true,
        };
      } else if (expression.includes('el.click()')) {
        this.event('Network.requestWillBeSent', {
          requestId: 'create-wire',
          request: { url: 'http://owned.invalid/api/session/create' },
        });
        this.event('Network.loadingFinished', { requestId: 'create-wire' });
        this.event('Network.requestWillBeSent', {
          requestId: 'prompt-wire',
          request: {
            url: 'http://owned.invalid/api/session/prompt',
            postData: JSON.stringify({
              payload: {
                args: { request: { sessionId: 'session-owned', requestId: 'prompt-owned' } },
              },
              credential: 'must-not-retain-wire-secret',
            }),
          },
        });
        this.event('Network.loadingFinished', { requestId: 'prompt-wire' });
        value = true;
      } else if (expression.includes('querySelectorAll(\'[role="status"]\')')) {
        boundary.push('ui-read-failed');
        this.frame({ id, error: { message: 'cdp-ui-disconnected' } });
        return;
      } else if (expression.startsWith('Boolean(document.querySelector')) {
        value = false;
      } else if (
        expression.includes('return usable(settings)') ||
        expression.includes('el.focus()')
      ) {
        value = true;
      } else {
        throw new Error('Unexpected CDP evaluation');
      }
      this.frame({ id, result: { result: { value } } });
    }

    send(data: string): void {
      // Frames come from the real project's CDP encoder, not untrusted fixture input.
      const command = JSON.parse(data) as {
        id: number;
        method: string;
        params: { expression?: string; requestId?: string };
      };
      let result: unknown = {};
      switch (command.method) {
        case 'Target.createTarget':
          result = { targetId: 'target-owned' };
          break;
        case 'Target.attachToTarget':
          result = { sessionId: 'cdp-owned' };
          break;
        case 'Network.enable':
        case 'Page.enable':
        case 'Runtime.enable':
        case 'Log.enable':
        case 'Network.setCookie':
        case 'Input.insertText':
          break;
        case 'Page.navigate':
          this.event('Page.loadEventFired', {});
          break;
        case 'Runtime.evaluate':
          this.evaluate(command.id, command.params.expression);
          return;
        case 'Network.getResponseBody':
          boundary.push(
            command.params.requestId === 'create-wire' ? 'create-receipt' : 'prompt-receipt',
          );
          result = {
            body: JSON.stringify({
              type: 'server-response',
              result: {
                ok: true,
                value:
                  command.params.requestId === 'create-wire'
                    ? { sessionId: 'session-owned' }
                    : { accepted: true, secret: 'must-not-retain-response-secret' },
              },
            }),
          };
          break;
        case 'Page.captureScreenshot':
          boundary.push('screenshot-failed');
          this.frame({ id: command.id, error: { message: 'cdp-screenshot-disconnected' } });
          return;
        default:
          throw new Error(`Unexpected CDP command ${command.method}`);
      }
      this.frame({ id: command.id, result });
    }

    close(): void {
      boundary.push('page-closed');
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
  }
  vi.stubGlobal('WebSocket', RefusalSocket);
  let failure: unknown;
  try {
    try {
      await captureModelRefusal({
        origin: 'http://owned.invalid',
        cookie: 'owned=dummy',
        extraFlags: [],
        expectedRoster: roster,
        chromeBin: bin,
        profile: join(work, 'profile'),
        pidFile: join(work, 'chrome.pid'),
        screenshot,
        browserMs: 5_000,
        beforeSubmit: () => {
          boundary.push('before-submit');
        },
        observe: () =>
          Promise.reject(new Error('Failed UI read must not reach acceptance observation')),
        retain: (prompt, screenshotCaptured) => {
          boundary.push('retained');
          writeFileSync(receipt, JSON.stringify({ prompt, screenshotCaptured }));
          boundary.push('enrichment-failed');
          return Promise.reject(new Error('session-enrichment-unavailable'));
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(existsSync(receipt)).toBe(true);
    expect(JSON.parse(readFileSync(receipt, 'utf8'))).toEqual({
      prompt: {
        sessionId: 'session-owned',
        requestId: 'prompt-owned',
        accepted: true,
        promptCount: 1,
        created: true,
        visibleError: false,
        consoleErrorCount: 0,
      },
      screenshotCaptured: false,
    });
    expect(boundary).toEqual([
      'before-submit',
      'create-receipt',
      'prompt-receipt',
      'ui-read-failed',
      'screenshot-failed',
      'retained',
      'enrichment-failed',
      'page-closed',
    ]);
    expect(existsSync(screenshot)).toBe(false);
    expect(readFileSync(stopped, 'utf8')).toBe('SIGTERM');
    const pid = Number(readFileSync(join(work, 'chrome.pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(failure).toBeInstanceOf(AggregateError);
    if (!(failure instanceof AggregateError)) throw new Error('Expected retained capture failures');
    expect(failure.cause).toEqual(new Error('cdp-ui-disconnected'));
    expect(failure.errors).toEqual([
      new Error('cdp-ui-disconnected'),
      new Error('cdp-screenshot-disconnected'),
      new Error('session-enrichment-unavailable'),
    ]);
  } finally {
    vi.unstubAllGlobals();
    // A broken driver must not leave the fixture child alive when assertions fail.
    const pidFile = join(work, 'chrome.pid');
    if (existsSync(pidFile)) {
      try {
        process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL');
      } catch {
        /* The driver already stopped this owned child. */
      }
    }
    rmSync(work, { recursive: true, force: true });
  }
});
