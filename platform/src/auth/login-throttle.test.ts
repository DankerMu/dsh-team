import { describe, expect, it } from 'vitest';
import { createLoginFailureLimiter, type LoginFailureLimiter } from './login-throttle.ts';

const NOW = 1_700_000_000_000;
const WINDOW_MS = 900_000;
const SWEEP_INTERVAL_MS = 60_000;
const EMAIL = 'user@example.com';
const OTHER_EMAIL = 'other@example.com';
const SOURCE = '192.0.2.20';
const OTHER_SOURCE = '198.51.100.7';

function recordFailures(
  limiter: LoginFailureLimiter,
  count: number,
  email = EMAIL,
  source = SOURCE,
  at = NOW,
): void {
  for (let attempt = 0; attempt < count; attempt += 1) {
    limiter.recordFailure(email, source, at);
  }
}

describe('createLoginFailureLimiter', () => {
  it('blocks only after ten completed failures in the first-failure window', () => {
    const limiter = createLoginFailureLimiter();

    recordFailures(limiter, 9);
    expect(limiter.isBlocked(EMAIL, SOURCE, NOW)).toBe(false);
    limiter.recordFailure(EMAIL, SOURCE, NOW);
    expect(limiter.isBlocked(EMAIL, SOURCE, NOW)).toBe(true);
    expect(limiter.isBlocked(EMAIL, SOURCE, NOW + WINDOW_MS - 1)).toBe(true);
  });

  it('keeps distinct email and source pairs independent', () => {
    const limiter = createLoginFailureLimiter();

    recordFailures(limiter, 10);
    expect(limiter.isBlocked(OTHER_EMAIL, SOURCE, NOW)).toBe(false);
    expect(limiter.isBlocked(EMAIL, OTHER_SOURCE, NOW)).toBe(false);
  });

  it('tracks independent windows for the same email on two sources', () => {
    const limiter = createLoginFailureLimiter();

    recordFailures(limiter, 3, EMAIL, SOURCE, NOW);
    recordFailures(limiter, 10, EMAIL, OTHER_SOURCE, NOW + 1);
    expect(limiter.isBlocked(EMAIL, SOURCE, NOW + 1)).toBe(false);
    expect(limiter.isBlocked(EMAIL, OTHER_SOURCE, NOW + 1)).toBe(true);
    recordFailures(limiter, 7, EMAIL, SOURCE, NOW + 1);
    expect(limiter.isBlocked(EMAIL, SOURCE, NOW + 1)).toBe(true);
    expect(limiter.isBlocked(EMAIL, SOURCE, NOW + WINDOW_MS)).toBe(false);
    expect(limiter.isBlocked(EMAIL, OTHER_SOURCE, NOW + WINDOW_MS)).toBe(true);
    expect(limiter.isBlocked(EMAIL, OTHER_SOURCE, NOW + 1 + WINDOW_MS)).toBe(false);
  });

  it('does not extend the window when later failures arrive before expiry', () => {
    const limiter = createLoginFailureLimiter();

    recordFailures(limiter, 9);
    expect(limiter.isBlocked(EMAIL, SOURCE, NOW + 1)).toBe(false);
    limiter.recordFailure(EMAIL, SOURCE, NOW + 1);
    expect(limiter.isBlocked(EMAIL, SOURCE, NOW + 1)).toBe(true);
    limiter.recordFailure(EMAIL, SOURCE, NOW + WINDOW_MS - 1);
    expect(limiter.isBlocked(EMAIL, SOURCE, NOW + WINDOW_MS - 1)).toBe(true);
    expect(limiter.isBlocked(EMAIL, SOURCE, NOW + WINDOW_MS)).toBe(false);
  });

  it('expires at the exact deadline and does not expire on a backward clock', () => {
    const limiter = createLoginFailureLimiter();

    recordFailures(limiter, 10);
    expect(limiter.isBlocked(EMAIL, SOURCE, NOW - 1)).toBe(true);
    expect(limiter.isBlocked(EMAIL, SOURCE, NOW + WINDOW_MS - 1)).toBe(true);
    expect(limiter.isBlocked(EMAIL, SOURCE, NOW + WINDOW_MS)).toBe(false);
    limiter.recordFailure(EMAIL, SOURCE, NOW + WINDOW_MS);
    expect(limiter.isBlocked(EMAIL, SOURCE, NOW + WINDOW_MS)).toBe(false);
    recordFailures(limiter, 9, EMAIL, SOURCE, NOW + WINDOW_MS);
    expect(limiter.isBlocked(EMAIL, SOURCE, NOW + WINDOW_MS)).toBe(true);
  });

  it('expires a completed window without clearing a later live pair', () => {
    const limiter = createLoginFailureLimiter();
    const liveEmail = 'live@example.com';

    recordFailures(limiter, 10);
    recordFailures(limiter, 10, liveEmail, SOURCE, NOW + 1);
    expect(limiter.isBlocked(EMAIL, SOURCE, NOW + SWEEP_INTERVAL_MS - 1)).toBe(true);
    expect(limiter.isBlocked(liveEmail, SOURCE, NOW + SWEEP_INTERVAL_MS - 1)).toBe(true);
    expect(limiter.isBlocked(EMAIL, SOURCE, NOW + WINDOW_MS)).toBe(false);
    expect(limiter.isBlocked(liveEmail, SOURCE, NOW + WINDOW_MS)).toBe(true);
    expect(limiter.isBlocked(liveEmail, SOURCE, NOW + WINDOW_MS + 1)).toBe(false);
  });

  it('isolates state between separately created limiters', () => {
    const first = createLoginFailureLimiter();
    const second = createLoginFailureLimiter();

    recordFailures(first, 10);
    expect(first.isBlocked(EMAIL, SOURCE, NOW)).toBe(true);
    expect(second.isBlocked(EMAIL, SOURCE, NOW)).toBe(false);
  });
});
