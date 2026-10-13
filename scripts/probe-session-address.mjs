import { observeNetwork } from './probe-dsh-api-cdp.mjs';

function addresses(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (value.kind === 'session' && typeof value.sessionId === 'string')
    found.push({ kind: value.kind, sessionId: value.sessionId });
  if (value.kind === 'subagent' && typeof value.childSessionId === 'string')
    found.push({
      kind: value.kind,
      childSessionId: value.childSessionId,
      parentSessionId: value.parentSessionId,
      mode: value.mode,
    });
  for (const child of Object.values(value))
    if (child && typeof child === 'object') addresses(child, found);
  return found;
}

/** Parse only native Session addresses; never retain transport headers, content or credentials. */
export function attachScopeObserver(page, evidence) {
  const consume = (raw) => {
    try {
      const value = JSON.parse(raw);
      evidence.addresses.push(...addresses(value));
    } catch {
      /* Non-JSON transport has no address proof. */
    }
  };
  page.on('Network.webSocketFrameSent', (event) => consume(event.response?.payloadData ?? ''));
  observeNetwork(page, {
    'Network.requestWillBeSent': (event) => {
      if (event.request?.postData) consume(event.request.postData);
    },
  });
}
