/** The origin-form target of a raw request URL: an absolute-form authority is dropped. */
export function requestTarget(url: string): string {
  const target = url.replace(/^https?:\/\/[^/?#]*/i, '');
  return target === '' || target.startsWith('?') ? `/${target}` : target;
}

/**
 * The path the router matches for a raw request URL: the target cut at its first `?` or `#`, then
 * decoded like find-my-way (reserved escapes such as `%2F` stay encoded). Null when the path
 * cannot be decoded, which the router answers with 400.
 */
export function routerPath(rawUrl: string): string | null {
  const path = requestTarget(rawUrl).split(/[?#]/, 1)[0] ?? '';
  try {
    return decodeURI(path);
  } catch {
    // Only a malformed escape throws; such a target has no path to classify.
    return null;
  }
}
