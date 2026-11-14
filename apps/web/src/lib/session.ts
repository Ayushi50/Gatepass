export type Role = 'attendee' | 'organizer' | 'door-staff';

export interface Session {
  token: string;
  sub: string;
  role: Role;
  /** seconds since epoch */
  exp: number;
}

const KEY = 'gp.session';

/** Reads a JWT's claims for DISPLAY and expiry only. The gateway is what actually verifies it. */
export function decodeToken(token: string): Session | null {
  try {
    const payload = token.split('.')[1];
    if (!payload) return null;
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    if (
      typeof json.sub !== 'string' ||
      typeof json.role !== 'string' ||
      typeof json.exp !== 'number'
    )
      return null;
    return { token, sub: json.sub, role: json.role as Role, exp: json.exp };
  } catch {
    return null;
  }
}

export function getSession(now: number = Date.now()): Session | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const s = decodeToken(raw);
    if (!s || s.exp * 1000 <= now) {
      window.localStorage.removeItem(KEY);
      return null;
    }
    return s;
  } catch {
    return null; // storage blocked (private mode): treated as signed out
  }
}

export function setSession(token: string): Session | null {
  const s = decodeToken(token);
  if (!s) return null;
  try {
    window.localStorage.setItem(KEY, token);
  } catch {
    return null;
  }
  return s;
}

export function clearSession(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    /* nothing to clear */
  }
}
