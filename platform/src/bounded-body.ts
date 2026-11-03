/** Returns the body text, or null once it exceeds `limit` bytes (the rest is cancelled, not read). */
export async function readLimited(response: Response, limit: number): Promise<string | null> {
  if (response.body === null) return '';
  // Fetch bodies are byte streams; Node's global typing leaves their chunk type as any.
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString('utf8');
    size += value.byteLength;
    if (size > limit) {
      // Cancellation failure only concerns an already-rejected response.
      reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
}
