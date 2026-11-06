/**
 * One same-origin administrator API request. Every response body is read to its end before it
 * settles: a 200 as JSON, any other status as bytes. A transport failure or abort is status 0.
 */
export async function adminRequest(
  url: string,
  signal: AbortSignal,
  method: string,
  payload?: unknown,
): Promise<{ status: number; body: unknown; readable: boolean }> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      credentials: 'same-origin',
      redirect: 'error',
      signal,
      ...(payload === undefined
        ? {}
        : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
    });
  } catch {
    // Status 0 is neither a success nor a denial; callers treat it as a failed request.
    return { status: 0, body: undefined, readable: false };
  }
  try {
    const body: unknown =
      response.status === 200 ? await response.json() : await response.arrayBuffer();
    return { status: response.status, body, readable: true };
  } catch {
    // The status still governs denial; an unreadable body is never a success.
    return { status: response.status, body: undefined, readable: false };
  }
}
