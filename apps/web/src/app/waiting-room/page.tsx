'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { Header, NAV } from '@/components/Header';
import { Loading, State } from '@/components/State';
import { api, ApiError, type WaitingRoomView } from '@/lib/api';
import { useEvent } from '@/lib/events';
import { dateTimeOf } from '@/lib/format';
import { useRequireRole } from '@/lib/hooks';
import { admissionKey, writeSession } from '@/lib/storage';
import '@/styles/waiting-room.css';

const POLL_MS = 2000;

function waitText(seconds: number): string {
  if (seconds <= 1) return 'about a second';
  if (seconds < 60) return `about ${seconds} seconds`;
  const m = Math.ceil(seconds / 60);
  return `about ${m} minute${m === 1 ? '' : 's'}`;
}

function WaitingRoom() {
  const router = useRouter();
  const eventId = useSearchParams().get('event') ?? '';
  const event = useEvent(eventId);
  const signedIn = useRequireRole('attendee');
  const [view, setView] = useState<WaitingRoomView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const startPlace = useRef(0);

  useEffect(() => {
    if (!signedIn || !eventId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const apply = (v: WaitingRoomView) => {
      if (!live) return;
      setError(null);
      setView(v);
      if (v.state === 'waiting' && v.position > startPlace.current) startPlace.current = v.position;
      if (v.state === 'admitted') {
        writeSession(admissionKey(eventId), v.admissionToken);
        timer = setTimeout(() => router.replace(`/seats?event=${eventId}`), 2000);
        return;
      }
      timer = setTimeout(poll, POLL_MS);
    };
    const fail = (err: unknown) => {
      if (!live) return;
      if (err instanceof ApiError && err.status === 409)
        return router.replace(`/seats?event=${eventId}`); // no waiting room here
      if (err instanceof ApiError && err.status === 404) return setError('not-found');
      setError((err as Error).message);
      timer = setTimeout(poll, POLL_MS * 2); // a hiccup: keep your place and try again
    };
    const poll = () =>
      api<WaitingRoomView>(`/api/events/${eventId}/waiting-room`).then(apply, fail);

    api<WaitingRoomView>(`/api/events/${eventId}/waiting-room/join`, { method: 'POST' }).then(
      apply,
      fail,
    );
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [signedIn, eventId, router]);

  const ahead = view?.state === 'waiting' ? view.position - 1 : 0;
  const progress =
    view?.state === 'waiting' && startPlace.current > 0
      ? Math.round((1 - ahead / startPlace.current) * 100)
      : view?.state === 'admitted'
        ? 100
        : 0;

  return (
    <div className="pg-waiting-room">
      <Header nav={[NAV.shows(true), NAV.how(), NAV.host(), NAV.tickets()]} />
      <main className="wrap">
        {error === 'not-found' ? (
          <State title="We could not find that show.">
            <Link href="/events">Back to the shows</Link>
          </State>
        ) : (
          <>
            <p className="kicker">
              {view?.state === 'admitted'
                ? 'You are in'
                : event
                  ? `In the queue · ${dateTimeOf(event.startsAt)}`
                  : 'In the queue'}
            </p>
            {view?.state === 'admitted' ? (
              <h1>
                Your seats are <span className="italic accent">waiting.</span>
              </h1>
            ) : (
              <h1>
                {event ? `${event.title} is busy.` : 'This show is busy.'}{' '}
                <span className="italic accent">Hold tight.</span>
              </h1>
            )}
            <p className="lede" aria-live="polite">
              {view?.state === 'admitted'
                ? `You have ${Math.max(1, Math.round(view.expiresInSeconds / 60))} minutes to choose your seats.`
                : view?.state === 'waiting'
                  ? `You will be let in in ${waitText(view.estimatedWaitSeconds)}. Keep this page open: we move you forward as people ahead of you go in.`
                  : 'Finding your place in line…'}
            </p>

            {view === null && !error ? <Loading>Joining the queue…</Loading> : null}
            {view?.state === 'waiting' ? (
              <div className="queue">
                <div className="top">
                  <span className="muted" style={{ fontSize: 14 }}>
                    {ahead === 0
                      ? 'You are next'
                      : ahead === 1
                        ? 'Person ahead of you'
                        : 'People ahead of you'}
                  </span>
                  <span
                    className="place"
                    role="status"
                    aria-live="polite"
                    aria-label={`${ahead} ahead of you`}
                  >
                    {ahead}
                  </span>
                </div>
                <div className="track" aria-hidden="true">
                  <div style={{ width: `${progress}%` }}></div>
                </div>
              </div>
            ) : null}
            {error && error !== 'not-found' ? (
              <State tone="danger" role="alert" title="We lost touch with the queue.">
                {error}. Your place is kept; we are trying again.
              </State>
            ) : null}
            {view?.state === 'admitted' ? (
              <div className="actions">
                <Link className="btn btn-amber" href={`/seats?event=${eventId}`}>
                  Choose your seats
                </Link>
              </div>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <WaitingRoom />
    </Suspense>
  );
}
