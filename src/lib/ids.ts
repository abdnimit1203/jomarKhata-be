/**
 * Human-friendly unique IDs. Uniqueness is guaranteed by unique indexes in MongoDB; these only
 * generate candidates (the caller retries on a duplicate-key error).
 */
import { randomInt } from 'node:crypto';

/**
 * Support ID shown to the user, e.g. "JK-4827-1935" (D29). Never a login credential.
 * Random, not serial (doesn't reveal how many users exist, can't be guessed).
 * The "JK-0000-…" series is reserved for the owner/staff and set by hand (e.g. JK-0000-0001):
 * generated IDs always start with 1000–9999.
 */
export function newAccountId(): string {
  const first = String(randomInt(1000, 10_000));
  const second = String(randomInt(0, 10_000)).padStart(4, '0');
  return `JK-${first}-${second}`;
}

/** Referral code alphabet without look-alikes (no 0/O, 1/I/L). */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Own referral code, e.g. "JK7Q4M2X": "JK" + 6 random characters. */
export function newReferralCode(): string {
  let s = 'JK';
  for (let i = 0; i < 6; i++) s += ALPHABET[randomInt(0, ALPHABET.length)];
  return s;
}

/** Same normalisation as the app (lib/referral.ts): upper-case, no spaces/dashes, Bengali digits → ASCII. */
export function normalizeReferralCode(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const ascii = input
    .replace(/[০-৯]/g, (d) => String('০১২৩৪৫৬৭৮৯'.indexOf(d)))
    .replace(/[\s-]/g, '')
    .toUpperCase();
  return /^[A-Z0-9]{4,16}$/.test(ascii) ? ascii : null;
}
