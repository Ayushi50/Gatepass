'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Header, NAV } from '@/components/Header';
import { api } from '@/lib/api';
import { setSession, type Role } from '@/lib/session';
import '@/styles/sign-in.css';

const ROLES: { id: Role; name: string; hint: string; start: string }[] = [
  { id: 'attendee', name: 'Attendee', hint: 'Book seats, pay, see your tickets', start: '/events' },
  {
    id: 'organizer',
    name: 'Organizer',
    hint: 'Sales, refunds and the live feed',
    start: '/organizer?event=neon-nights',
  },
  { id: 'door-staff', name: 'Door staff', hint: 'Scan tickets at the gate', start: '/check-in' },
];

function SignIn() {
  const router = useRouter();
  const params = useSearchParams();
  const wanted = (params.get('role') as Role | null) ?? 'attendee';
  const next = params.get('next');
  const [role, setRole] = useState<Role>(ROLES.some((r) => r.id === wanted) ? wanted : 'attendee');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ token: string }>('/api/dev-login', {
        method: 'POST',
        auth: false,
        body: { role, ...(role === 'attendee' && name.trim() ? { name: name.trim() } : {}) },
      });
      if (!setSession(res.token))
        throw new Error(
          'This browser would not keep the sign-in. Allow site storage and try again.',
        );
      // `next` only ever leads somewhere on this site
      const safe =
        next && next.startsWith('/') && !next.startsWith('//')
          ? next
          : ROLES.find((r) => r.id === role)!.start;
      router.replace(safe);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="pg-sign-in">
      <Header nav={[NAV.shows(), NAV.how(), NAV.host(), NAV.tickets()]} />
      <main className="wrap">
        <p className="kicker">Demo sign-in</p>
        <h1>
          Who is <span className="italic accent">this?</span>
        </h1>
        <p className="lede">
          There are no real accounts yet. Pick a role to try the app; nothing here is a real person.
        </p>

        <div className="methods roles" role="radiogroup" aria-label="Role">
          {ROLES.map((r) => (
            <button
              key={r.id}
              type="button"
              className="radio-card"
              role="radio"
              aria-checked={role === r.id}
              onClick={() => setRole(r.id)}
            >
              <span className="ring" aria-hidden="true"></span>
              <span>
                <span className="name">{r.name}</span>
                <span className="hint">{r.hint}</span>
              </span>
            </button>
          ))}
        </div>

        {role === 'attendee' ? (
          <div className="field">
            <label htmlFor="name">Your name (optional)</label>
            <input
              id="name"
              type="text"
              placeholder="aarav"
              autoComplete="off"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="hint">Use a different name in each browser to try two people at once.</p>
          </div>
        ) : null}

        <button
          type="button"
          className="btn btn-amber btn-block"
          style={{ marginTop: 30, minHeight: 60, fontSize: 17 }}
          disabled={busy}
          onClick={() => void go()}
        >
          {busy ? 'Signing in…' : 'Continue'}
        </button>
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <SignIn />
    </Suspense>
  );
}
