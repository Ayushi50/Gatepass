'use client';
import { useEffect, useState } from 'react';
import { getSession, type Role, type Session } from './session';

/** The signed-in user, read after mount (the server render has no storage). `undefined` = not read yet. */
export function useSession(): Session | null | undefined {
  const [session, setSession] = useState<Session | null | undefined>(undefined);
  useEffect(() => setSession(getSession()), []);
  return session;
}

/** Sends the visitor to sign in (and back) unless they hold `role`. Returns true once they do. */
export function useRequireRole(role: Role): boolean {
  const session = useSession();
  useEffect(() => {
    if (session === undefined) return;
    if (!session || session.role !== role) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.replace(`/sign-in?role=${role}&next=${next}`);
    }
  }, [session, role]);
  return !!session && session.role === role;
}

/** Re-renders every `ms` so relative times ("14s ago") stay true. */
export function useTick(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}
