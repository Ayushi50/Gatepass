import { createHash } from 'node:crypto';

// No 0/O/1/I so a code read aloud or off a screen is unambiguous.
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

/** A short, stable, human-friendly code for a booking, like "GP-7QX2". Display only; not a secret. */
export function bookingCode(bookingId: string): string {
  const digest = createHash('sha256').update(bookingId).digest();
  let code = '';
  for (let i = 0; i < 4; i++) code += ALPHABET[digest[i]! % ALPHABET.length];
  return `GP-${code}`;
}

/** The code printed on a ticket, like "GP-7QX2-C6". */
export const ticketCode = (bookingId: string, seatId: string): string =>
  `${bookingCode(bookingId)}-${seatId}`;
