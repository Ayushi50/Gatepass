'use client';
import { useEffect, useState } from 'react';
import { clearSession, getSession } from '@/lib/session';

/** "Sign out", shown only to someone who is signed in. Clears the session and goes to sign-in. */
export function SignOut() {
  const [who, setWho] = useState<string | null>(null);
  useEffect(() => setWho(getSession()?.role ?? null), []);
  if (!who) return null;
  return (
    <button
      type="button"
      className="signout"
      onClick={() => {
        clearSession();
        // a full load, so nothing from the last person (tickets, holds) stays in memory
        window.location.assign('/sign-in');
      }}
    >
      Sign out
    </button>
  );
}
