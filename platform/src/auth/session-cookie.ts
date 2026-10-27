const SESSION_COOKIE_NAME = 'platform_session';
const SESSION_COOKIE_ATTRIBUTES = 'Path=/; HttpOnly; SameSite=Lax';
const TOKEN_HEX_LENGTH = 64;
const TOKEN_HEX = /^[0-9a-f]{64}$/;

export function formatSessionCookie(token: string | null, cookieSecure: boolean): string {
  const value = token ?? '';
  let cookie = `${SESSION_COOKIE_NAME}=${value}; ${SESSION_COOKIE_ATTRIBUTES}`;
  if (token === null) {
    cookie += '; Max-Age=0';
  }
  if (cookieSecure) {
    cookie += '; Secure';
  }
  return cookie;
}

/** Every platform_session pair's value, or null for a valueless name, in header order. */
function sessionCookieValues(header: string): (string | null)[] {
  const values: (string | null)[] = [];
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    const name = separator === -1 ? pair.trim() : pair.slice(0, separator).trim();
    if (name === SESSION_COOKIE_NAME)
      values.push(separator === -1 ? null : pair.slice(separator + 1));
  }
  return values;
}

export function readSessionCookie(header: string | undefined): string | null {
  const values = header === undefined ? [] : sessionCookieValues(header);
  const token = values.length === 1 ? values[0] : null;
  if (token?.length !== TOKEN_HEX_LENGTH || TOKEN_HEX.exec(token) === null) {
    return null;
  }
  return token;
}

/** The number of platform_session pairs; more than one means a shadowing cookie. */
export function countSessionCookies(header: string | undefined): number {
  return header === undefined ? 0 : sessionCookieValues(header).length;
}
