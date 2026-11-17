'use client';
import type { ReactNode } from 'react';
import { useRequireSignIn } from '@/lib/hooks';

/** Shows its page only to someone who is signed in; everyone else is sent to sign in first. */
export function SignInGate({
  children,
  returnTo = true,
}: {
  children: ReactNode;
  returnTo?: boolean;
}) {
  const signedIn = useRequireSignIn(returnTo);
  return signedIn ? <>{children}</> : null;
}
