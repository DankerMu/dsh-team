import { randomInt } from 'node:crypto';

const USER_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const USER_ID_LENGTH = 12;
const INTERNAL_WHITESPACE = /\s/;

export function normalizeEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  const at = email.indexOf('@');
  if (
    at <= 0 ||
    at !== email.lastIndexOf('@') ||
    at >= email.length - 1 ||
    INTERNAL_WHITESPACE.test(email)
  ) {
    return null;
  }
  return email;
}

export function generateUserId(): string {
  let id = '';
  for (let index = 0; index < USER_ID_LENGTH; index += 1) {
    id += USER_ID_ALPHABET.charAt(randomInt(USER_ID_ALPHABET.length));
  }
  return id;
}
