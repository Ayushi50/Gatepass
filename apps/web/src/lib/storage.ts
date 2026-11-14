/** sessionStorage helpers that never throw (private mode, blocked storage). */
export function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function writeSession(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    /* the value just will not survive a reload */
  }
}

export function removeSession(key: string): void {
  try {
    window.sessionStorage.removeItem(key);
  } catch {
    /* nothing to remove */
  }
}

/** One Idempotency-Key per booking, kept for the tab: a retry or double click reuses it. */
export function idempotencyKeyFor(bookingId: string): string {
  const k = `gp.idem.${bookingId}`;
  const existing = readSession(k);
  if (existing) return existing;
  const fresh = `web-${bookingId.slice(0, 8)}-${crypto.randomUUID()}`;
  writeSession(k, fresh);
  return fresh;
}

export const admissionKey = (eventId: string) => `gp.admission.${eventId}`;
export const pendingSeatsKey = (eventId: string) => `gp.pending.${eventId}`;
