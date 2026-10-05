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

export function readSessionCookie(header: string | undefined): string | null {
  if (header === undefined) {
    return null;
  }
  let token: string | undefined;
  for (const pair of header.split(';')) {
    const trimmed = pair.trim();
    const separator = pair.indexOf('=');
    const name = separator === -1 ? trimmed : pair.slice(0, separator).trim();
    if (name !== SESSION_COOKIE_NAME) {
      continue;
    }
    if (token !== undefined || separator === -1) {
      return null;
    }
    token = pair.slice(separator + 1);
  }
  if (token?.length !== TOKEN_HEX_LENGTH || TOKEN_HEX.exec(token) === null) {
    return null;
  }
  return token;
}
