'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { StepsHeader } from '@/components/Header';
import { Loading, State } from '@/components/State';
import { api, ApiError, type Booking } from '@/lib/api';
import { useRequireRole } from '@/lib/hooks';
import { openStream } from '@/lib/sse';
import '@/styles/status.css';

type StreamMessage =
  | {
      kind: 'snapshot';
      state: Booking['state'];
      cancelReason: string | null;
      ticketsIssued: boolean;
    }
  | { kind: 'event'; type: string; reason?: string };

type Mode = 'progress' | 'confirmed' | 'failed' | 'expired';

const COPY: Record<Mode, { kicker: string; title: React.ReactNode; lede: string }> = {
  progress: {
    kicker: 'Hang tight',
    title: (
      <>
        The lights are <span className="italic accent">coming up.</span>
      </>
    ),
    lede: 'We are confirming your payment and issuing your tickets. This usually takes a few seconds.',
  },
  confirmed: {
    kicker: 'You are in',
    title: (
      <>
        See you <span className="italic accent">inside.</span>
      </>
    ),
    lede: 'Your payment went through and your tickets are ready.',
  },
  failed: {
    kicker: 'Something went wrong',
    title: (
      <>
        The lights went <span className="italic accent">back down.</span>
      </>
    ),
    lede: 'Your payment did not go through, and nothing was charged. Your seats were released so others can book them.',
  },
  expired: {
    kicker: 'Time ran out',
    title: (
      <>
        The lights went <span className="italic accent">back down.</span>
      </>
    ),
    lede: 'Your hold ran out before the payment cleared. Your seats were released, and if you were charged it is being refunded.',
  },
};

type LightState = 'done' | 'active' | 'wait' | 'failed';
const TICK = (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path
      d="M2.5 7.5l3 3 6-7"
      stroke="#0D0A10"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const CROSS = (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M2 2l8 8M10 2l-8 8" stroke="#FF8A97" strokeWidth="2" strokeLinecap="round" />
  </svg>
);

function Status() {
  const bookingId = useSearchParams().get('booking') ?? '';
  const signedIn = useRequireRole('attendee');
  const [booking, setBooking] = useState<Booking | null>(null);
  const [seen, setSeen] = useState<Set<string>>(new Set());
  const [snapshot, setSnapshot] = useState<{
    state: Booking['state'];
    cancelReason: string | null;
    ticketsIssued: boolean;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!signedIn || !bookingId) return;
    api<Booking>(`/api/bookings/${bookingId}`).then(setBooking, (e) =>
      setError(e instanceof ApiError && e.status === 404 ? 'not-found' : e.message),
    );
    const abort = new AbortController();
    void openStream<StreamMessage>(`/api/bookings/${bookingId}/stream`, {
      signal: abort.signal,
      onRefused: (s) => setError(s === 404 ? 'not-found' : 'This booking is not yours.'),
      onMessage: (m) => {
        if (m.kind === 'snapshot')
          setSnapshot({
            state: m.state,
            cancelReason: m.cancelReason,
            ticketsIssued: m.ticketsIssued,
          });
        else setSeen((prev) => new Set(prev).add(m.type));
      },
    });
    return () => abort.abort();
  }, [signedIn, bookingId]);

  // Lights only ever turn on: a step seen live, or already true in the snapshot, stays lit.
  const state = snapshot?.state;
  const cancelReason = snapshot?.cancelReason ?? null;
  const cancelled =
    state === 'CANCELLED' || seen.has('booking.cancelled') || seen.has('payment.failed');
  const held = seen.has('seats.held') || (!!state && state !== 'REQUESTED');
  const paid = seen.has('payment.succeeded') || state === 'PAID' || state === 'CONFIRMED';
  const ticketed = seen.has('ticket.issued') || !!snapshot?.ticketsIssued;
  const expired = cancelled && !seen.has('payment.failed') && cancelReason === 'hold_expired';

  const mode: Mode = ticketed
    ? 'confirmed'
    : expired
      ? 'expired'
      : cancelled
        ? 'failed'
        : 'progress';
  const lights: [string, LightState, string][] = [
    [
      'Seats held',
      held ? 'done' : cancelled ? 'failed' : 'active',
      held ? 'Done' : cancelled ? 'Failed' : 'Working',
    ],
    [
      'Payment received',
      paid ? 'done' : cancelled ? 'failed' : held ? 'active' : 'wait',
      paid ? 'Done' : cancelled ? 'Failed' : held ? 'Working' : 'Waiting',
    ],
    [
      'Ticket issued',
      ticketed ? 'done' : cancelled ? 'wait' : paid ? 'active' : 'wait',
      ticketed ? 'Done' : cancelled ? 'Not issued' : paid ? 'Working' : 'Waiting',
    ],
  ];
  const c = COPY[mode];

  return (
    <div className="pg-status">
      <StepsHeader current="tickets" />
      <main className="wrap">
        {error ? (
          <State
            tone="danger"
            role="alert"
            title={
              error === 'not-found'
                ? 'We could not find that booking.'
                : 'We cannot show this booking.'
            }
          >
            {error === 'not-found' ? null : error} <Link href="/events">Back to the shows</Link>
          </State>
        ) : (
          <>
            <p className="kicker" id="kicker">
              {c.kicker}
            </p>
            <h1 id="title">{c.title}</h1>
            <p className="lede" id="lede" aria-live="polite">
              {c.lede}
            </p>
            {!snapshot && !booking ? <Loading>Checking on your booking…</Loading> : null}

            <ul className="lights" id="lights">
              {lights.map(([name, s, text]) => (
                <li className="light" data-s={s} key={name}>
                  <span className="bulb">
                    {s === 'done' ? TICK : s === 'failed' ? CROSS : null}
                  </span>
                  <span className="name">{name}</span>
                  <span className="state">{text}</span>
                </li>
              ))}
            </ul>
            <div className="actions" id="actions">
              {mode === 'confirmed' ? (
                <>
                  <Link className="btn btn-amber" href="/tickets">
                    View my tickets
                  </Link>
                  <Link className="btn btn-ghost" href="/events">
                    Browse more shows
                  </Link>
                </>
              ) : null}
              {mode === 'failed' || mode === 'expired' ? (
                <>
                  <Link className="btn btn-amber" href={`/checkout?booking=${bookingId}`}>
                    Try paying again
                  </Link>
                  <Link
                    className="btn btn-ghost"
                    href={booking ? `/seats?event=${booking.eventId}` : '/events'}
                  >
                    Pick new seats
                  </Link>
                </>
              ) : null}
              {mode === 'progress' ? (
                <span className="muted" style={{ fontSize: 14 }}>
                  You can leave this page. We will email you when your tickets are ready.
                </span>
              ) : null}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Status />
    </Suspense>
  );
}
