import { afterEach, expect, it, vi } from 'vitest';
import { adminRequest } from './admin-request.ts';

afterEach(() => {
  vi.unstubAllGlobals();
});
function stub(reply: () => Promise<Response>) {
  const request = vi.fn<typeof fetch>(reply);
  vi.stubGlobal('fetch', request);
  return request;
}

it('reads a same-origin GET without a body and parses its 200 JSON', async () => {
  const request = stub(() => Promise.resolve(new Response('{"value":1}')));
  const signal = new AbortController().signal;

  const result = await adminRequest('/_platform/api/admin/example', signal, 'GET');

  expect(result).toEqual({ status: 200, body: { value: 1 }, readable: true });
  expect(request.mock.calls).toEqual([
    [
      '/_platform/api/admin/example',
      { method: 'GET', credentials: 'same-origin', redirect: 'error', signal },
    ],
  ]);
});

it('sends a JSON payload with its content type', async () => {
  const request = stub(() => Promise.resolve(new Response('{}')));
  const signal = new AbortController().signal;

  await adminRequest('/_platform/api/admin/example', signal, 'PUT', { name: 'x' });

  expect(request.mock.calls[0]?.[1]).toEqual({
    method: 'PUT',
    credentials: 'same-origin',
    redirect: 'error',
    signal,
    headers: { 'Content-Type': 'application/json' },
    body: '{"name":"x"}',
  });
});

it('reads a rejection body to its end without parsing it', async () => {
  const response = new Response('not json', { status: 400 });
  const read = vi.spyOn(response, 'arrayBuffer');
  stub(() => Promise.resolve(response));

  const result = await adminRequest('/x', new AbortController().signal, 'POST', {});

  expect(read).toHaveBeenCalledTimes(1);
  expect(result.status).toBe(400);
  expect(result.readable).toBe(true);
  expect(result.body).toBeInstanceOf(ArrayBuffer);
});

it('reports an unreadable success body as unreadable with its status', async () => {
  stub(() => Promise.resolve(new Response('not json')));

  const result = await adminRequest('/x', new AbortController().signal, 'GET');

  expect(result).toEqual({ status: 200, body: undefined, readable: false });
});

it('settles a transport failure as unreadable status 0', async () => {
  stub(() => Promise.reject(new Error('private-data')));

  const result = await adminRequest('/x', new AbortController().signal, 'GET');

  expect(result).toEqual({ status: 0, body: undefined, readable: false });
});
