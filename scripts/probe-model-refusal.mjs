import { closeMapped, navigateReady, openMappedPage } from './probe-mapped-host.mjs';
import { sleep } from './probe-dsh-api-cdp.mjs';
import {
  captureSettledScreenshot,
  clickSelector,
  evalPage,
  remainingMs,
  SEND_BTN,
  typeComposer,
} from './probe-dsh-api-ui.mjs';
import { waitCompositionInitialized } from './probe-first-run-composition.mjs';

async function collectAdmissions(page, calls, completed, prompt, admission) {
  for (const requestId of completed.splice(0)) {
    try {
      const response = await page.send('Network.getResponseBody', { requestId });
      const body = JSON.parse(response.body);
      if (body.type !== 'server-response' || body.result?.ok !== true) throw new Error();
      if (calls.get(requestId) === '/api/session/create')
        admission.createdId = body.result.value.sessionId;
      else prompt.accepted = body.result.value?.accepted === true;
    } catch {
      admission.wireFailure = true;
    }
  }
}

/** Drive the released UI, retain only Session identities and prompt admission, never wire bodies. */
export async function captureModelRefusal(input) {
  const opened = await openMappedPage({ ...input, composition: true });
  const { page, chrome, errors } = opened;
  const until = Date.now() + input.browserMs;
  const calls = new Map();
  const completed = [];
  const prompt = { sessionId: '', requestId: '', accepted: false, promptCount: 0, created: false };
  const admission = { createdId: '', wireFailure: false };
  let visibleError = false;
  page.on('Network.requestWillBeSent', ({ requestId, request }) => {
    const path = new URL(request.url).pathname;
    if (!['/api/session/create', '/api/session/prompt'].includes(path)) return;
    calls.set(requestId, path);
    if (path !== '/api/session/prompt') return;
    prompt.promptCount++;
    try {
      const body = JSON.parse(request.postData);
      const accepted = body.payload.args.request;
      if (typeof accepted.sessionId !== 'string' || typeof accepted.requestId !== 'string')
        throw new Error();
      prompt.sessionId = accepted.sessionId;
      prompt.requestId = accepted.requestId;
    } catch {
      admission.wireFailure = true;
    }
  });
  page.on('Network.loadingFinished', ({ requestId }) => {
    if (calls.has(requestId)) completed.push(requestId);
  });
  page.on('Network.loadingFailed', ({ requestId }) => {
    if (calls.has(requestId)) admission.wireFailure = true;
  });
  try {
    await navigateReady(page, input.origin, remainingMs(until, 'model-startup'));
    const ready = await waitCompositionInitialized(
      page,
      remainingMs(until, 'model-composer'),
      false,
      input.expectedRoster,
    );
    if (!ready.initialized) throw new Error('Model composer not initialized');
    const stale = await evalPage(page, 'Boolean(document.querySelector(\'[role="status"] code\'))');
    if (stale) throw new Error('Unexpected pre-prompt error');
    await input.beforeSubmit();
    await typeComposer(page, 'Reply with one word: hello.');
    await clickSelector(page, SEND_BTN);
    for (;;) {
      remainingMs(until, 'model-terminal');
      await collectAdmissions(page, calls, completed, prompt, admission);
      prompt.created = admission.createdId !== '' && admission.createdId === prompt.sessionId;
      visibleError = await evalPage(
        page,
        `(function(){
        return [...document.querySelectorAll('[role="status"]')].some(el=>
          el.getClientRects().length&&el.querySelector('code')?.textContent==='TRANSPORT'&&
          /connection|ECONNREFUSED|fetch failed/i.test(el.textContent));
      })()`,
      );
      const terminal = await input.observe({
        ...prompt,
        accepted: prompt.accepted && prompt.created && !admission.wireFailure,
        visibleError,
        consoleErrorCount: errors.length,
      });
      if (terminal) return;
      await sleep(250);
    }
  } finally {
    try {
      await captureSettledScreenshot(page, input.screenshot);
      await input.retain({
        ...prompt,
        accepted: prompt.accepted && prompt.created && !admission.wireFailure,
        visibleError,
        consoleErrorCount: errors.length,
      });
    } finally {
      await closeMapped(page, chrome);
    }
  }
}
