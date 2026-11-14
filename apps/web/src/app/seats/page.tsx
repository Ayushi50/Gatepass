'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Fragment, Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Header, NAV } from '@/components/Header';
import { Loading, State } from '@/components/State';
import { api, ApiError, type Booking, type Seat } from '@/lib/api';
import { admissionToken, useEvent } from '@/lib/events';
import { dateTimeOf, fmt, sortSeats, splitSeat, splitTitle } from '@/lib/format';
import { getSession } from '@/lib/session';
import { openStream } from '@/lib/sse';
import {
  admissionKey,
  pendingSeatsKey,
  readSession,
  removeSession,
  writeSession,
} from '@/lib/storage';
import '@/styles/seats.css';

const MAX = 6;
const STATE_TEXT = {
  available: 'available',
  taken: 'taken',
  held: 'held by someone else',
  selected: 'selected',
} as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function SeatsPage() {
  const router = useRouter();
  const eventId = useSearchParams().get('event') ?? '';
  const event = useEvent(eventId);

  const [seats, setSeats] = useState<Seat[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [live, setLive] = useState<Record<string, Seat['state']>>({});
  const [picked, setPicked] = useState<string[]>([]);
  const [holding, setHolding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadSeats = useCallback(async () => {
    try {
      setSeats(await api<Seat[]>(`/api/events/${eventId}/seats`, { auth: false }));
      setLive({});
      setLoadError(null);
    } catch (err) {
      setLoadError(
        err instanceof ApiError && err.status === 404 ? 'not-found' : (err as Error).message,
      );
    }
  }, [eventId]);
  useEffect(() => void loadSeats(), [loadSeats]);

  // A high-demand show is entered through the waiting room.
  useEffect(() => {
    if (event && event.waitingRoom && !admissionToken(eventId))
      router.replace(`/waiting-room?event=${eventId}`);
  }, [event, eventId, router]);

  // Seats update live. After a dropped connection the map is re-read, so nothing is missed.
  useEffect(() => {
    if (!eventId) return;
    const abort = new AbortController();
    let opened = false;
    void openStream<{ seatId: string; state: Seat['state'] }>(
      `/api/events/${eventId}/seats/stream`,
      {
        auth: false,
        signal: abort.signal,
        onMessage: (m) => setLive((prev) => ({ ...prev, [m.seatId]: m.state })),
        onStatus: (s) => {
          if (s === 'open') {
            if (opened) void loadSeats();
            opened = true;
          }
        },
      },
    );
    return () => abort.abort();
  }, [eventId, loadSeats]);

  // Picks made before signing in come back with the visitor.
  useEffect(() => {
    if (!seats) return;
    const saved = readSession(pendingSeatsKey(eventId));
    if (!saved) return;
    removeSession(pendingSeatsKey(eventId));
    try {
      const ids = (JSON.parse(saved) as string[]).filter((id) =>
        seats.some((s) => s.id === id && s.state === 'available'),
      );
      setPicked(ids.slice(0, MAX));
    } catch {
      /* ignore a damaged value */
    }
  }, [seats, eventId]);

  const stateOf = useCallback(
    (seat: Seat): 'available' | 'held' | 'taken' | 'selected' => {
      const current = live[seat.id] ?? seat.state;
      return current === 'available' && picked.includes(seat.id) ? 'selected' : current;
    },
    [live, picked],
  );

  // A seat you picked that someone else gets first is taken off your list, and you are told.
  useEffect(() => {
    if (!seats) return;
    const lost = picked.filter((id) => {
      const s = seats.find((x) => x.id === id);
      return s && (live[id] ?? s.state) !== 'available';
    });
    if (lost.length) {
      setPicked((p) => p.filter((id) => !lost.includes(id)));
      setNotice(
        `${lost.map((id) => `Row ${splitSeat(id).row}, seat ${splitSeat(id).number}`).join('; ')} just went to someone else.`,
      );
    }
  }, [live, seats, picked]);

  const rows = useMemo(() => {
    const byRow = new Map<string, Seat[]>();
    for (const s of seats ?? []) byRow.set(s.row, [...(byRow.get(s.row) ?? []), s]);
    return [...byRow]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([row, list]) => ({ row, seats: list.sort((a, b) => a.number - b.number) }));
  }, [seats]);

  function toggle(id: string) {
    setNotice(null);
    setPicked((p) =>
      p.includes(id) ? p.filter((x) => x !== id) : p.length < MAX ? [...p, id] : p,
    );
  }

  async function hold() {
    if (holding || picked.length === 0) return;
    setNotice(null);
    const session = getSession();
    if (!session || session.role !== 'attendee') {
      writeSession(pendingSeatsKey(eventId), JSON.stringify(picked));
      router.push(`/sign-in?role=attendee&next=${encodeURIComponent(`/seats?event=${eventId}`)}`);
      return;
    }
    const headers: Record<string, string> = {};
    if (event?.waitingRoom) {
      const pass = admissionToken(eventId);
      if (!pass) {
        router.replace(`/waiting-room?event=${eventId}`);
        return;
      }
      headers['x-admission-token'] = pass;
    }

    setHolding(true);
    try {
      const created = await api<Booking>('/api/bookings', {
        method: 'POST',
        body: { eventId, seatIds: sortSeats(picked) },
        headers,
      });
      // Holding is decided a moment later by the seat service; wait for its answer.
      for (let i = 0; i < 30; i++) {
        const b = await api<Booking>(`/api/bookings/${created.id}`);
        if (b.state === 'CANCELLED') {
          setNotice(
            'Someone else got one of those seats first. The map is up to date: pick again.',
          );
          setPicked([]);
          await loadSeats();
          return;
        }
        if (b.state !== 'REQUESTED') break;
        await sleep(500);
      }
      router.push(`/checkout?booking=${created.id}`);
    } catch (err) {
      if (
        err instanceof ApiError &&
        err.status === 403 &&
        String(err.code ?? '').startsWith('admission')
      ) {
        removeSession(admissionKey(eventId));
        router.replace(`/waiting-room?event=${eventId}`);
      } else if (
        err instanceof ApiError &&
        err.status === 403 &&
        err.code === 'waiting_room_required'
      ) {
        router.replace(`/waiting-room?event=${eventId}`);
      } else if (err instanceof ApiError && err.status === 401) {
        router.push(`/sign-in?role=attendee&next=${encodeURIComponent(`/seats?event=${eventId}`)}`);
      } else {
        setNotice(
          err instanceof ApiError && err.offline
            ? 'We could not reach the server. Try again in a moment.'
            : (err as Error).message,
        );
      }
    } finally {
      setHolding(false);
    }
  }

  const sorted = sortSeats(picked);
  const total = sorted.reduce((sum, id) => sum + (seats?.find((s) => s.id === id)?.price ?? 0), 0);
  const n = sorted.length;
  const [titleHead, titleTail] = splitTitle(event?.title ?? '');

  return (
    <div className="pg-seats">
      <Header nav={[NAV.shows(true), NAV.how(), NAV.host(), NAV.tickets()]} />
      <main>
        <section className="title-row">
          <div>
            <p className="kicker">{event ? dateTimeOf(event.startsAt) : ' '}</p>
            <h1>
              {titleHead} <span className="italic">{titleTail}</span>
            </h1>
            <p className="muted" style={{ margin: 0, fontSize: 17 }}>
              {event ? `${event.venue} · pick up to six seats` : ' '}
            </p>
          </div>
          <div className="chip">
            <span className="dot-live" aria-hidden="true"></span>
            <span>Seats update live</span>
          </div>
        </section>

        <div className="layout">
          <section className="map" aria-label="Seat map">
            <div className="stage-glow" aria-hidden="true"></div>
            <div className="stage-line" aria-hidden="true"></div>
            <p className="stage-label" aria-hidden="true">
              STAGE
            </p>
            {seats === null && !loadError ? <Loading>Loading the seat map…</Loading> : null}
            {loadError === 'not-found' ? (
              <State title="These seats are not on sale yet.">
                <a href="/events">Back to the shows</a>
              </State>
            ) : loadError ? (
              <State tone="danger" title="We could not load the seat map." role="alert">
                {loadError}.
                <br />
                <button type="button" className="btn btn-ghost" onClick={() => void loadSeats()}>
                  Try again
                </button>
              </State>
            ) : null}
            {seats ? (
              <div className="map-scroll">
                <div className="rows" id="rows">
                  {rows.map(({ row, seats: rowSeats }) => {
                    const aisleBefore = Math.floor(rowSeats.length / 2) + 1;
                    return (
                      <div className="row" key={row}>
                        <span className="rl">{row}</span>
                        <div className="seats">
                          {rowSeats.map((seat, i) => {
                            const st = stateOf(seat);
                            const x = i + 1 - (rowSeats.length + 1) / 2;
                            const ty = -Math.round(x * x * 0.45);
                            return (
                              <Fragment key={seat.id}>
                                {i + 1 === aisleBefore ? <div className="aisle"></div> : null}
                                <button
                                  type="button"
                                  className="seat"
                                  data-id={seat.id}
                                  data-state={st}
                                  style={{ transform: `translateY(${ty}px)` }}
                                  disabled={st === 'taken' || st === 'held'}
                                  aria-pressed={st === 'selected'}
                                  aria-label={`Row ${seat.row}, seat ${seat.number}, ${seat.tier} tier, ${fmt(seat.price)}, ${STATE_TEXT[st]}`}
                                  onClick={() => toggle(seat.id)}
                                >
                                  <span className="seat-dot">
                                    {st === 'selected' ? (
                                      <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 14 14"
                                        fill="none"
                                        aria-hidden="true"
                                      >
                                        <path
                                          d="M2.5 7.5l3 3 6-7"
                                          stroke="#0D0A10"
                                          strokeWidth="2.2"
                                          strokeLinecap="round"
                                          strokeLinejoin="round"
                                        />
                                      </svg>
                                    ) : null}
                                    {st === 'taken' ? (
                                      <svg
                                        width="12"
                                        height="12"
                                        viewBox="0 0 12 12"
                                        fill="none"
                                        aria-hidden="true"
                                      >
                                        <path
                                          d="M2.5 2.5l7 7M9.5 2.5l-7 7"
                                          stroke="#8E8294"
                                          strokeWidth="1.8"
                                          strokeLinecap="round"
                                        />
                                      </svg>
                                    ) : null}
                                  </span>
                                </button>
                              </Fragment>
                            );
                          })}
                        </div>
                        <span className="tier">{rowSeats[0]?.tier}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
            <ul className="legend" aria-label="Seat legend">
              <li>
                <span className="sw"></span>Available
              </li>
              <li>
                <span className="sw yours"></span>Yours
              </li>
              <li>
                <span className="sw held"></span>Someone is paying
              </li>
              <li>
                <span className="sw taken"></span>Taken
              </li>
            </ul>
          </section>

          <aside>
            <div className="stub">
              <div className="stub-body" style={{ paddingBottom: 20 }}>
                <p className="kicker" id="count-label">
                  {n === 1 ? '1 seat chosen' : `${n} seats chosen`}
                </p>
                <h2>Your seats</h2>
                <p className="muted" id="limit-note" style={{ margin: '0 0 14px', fontSize: 14 }}>
                  {n >= MAX ? 'That is the maximum of six.' : 'Choose up to six.'}
                </p>
                <p
                  className="muted"
                  id="empty-note"
                  style={{ margin: 0, padding: '18px 0', fontSize: 15 }}
                  hidden={n !== 0}
                >
                  Choose a seat on the map to begin.
                </p>
                <ul id="selected" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {sorted.map((id) => {
                    const seat = seats?.find((s) => s.id === id);
                    const { row, number } = splitSeat(id);
                    return (
                      <li className="line-item" key={id}>
                        <div>
                          <div className="t">{`Row ${row}, seat ${number}`}</div>
                          <div className="s">{seat?.tier}</div>
                        </div>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                          <span className="t">{fmt(seat?.price ?? 0)}</span>
                          <button
                            type="button"
                            className="icon-btn"
                            aria-label={`Remove row ${row}, seat ${number}`}
                            onClick={() => toggle(id)}
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 14 14"
                              fill="none"
                              aria-hidden="true"
                            >
                              <path
                                d="M2 2l10 10M12 2L2 12"
                                stroke="#B8ADBD"
                                strokeWidth="2"
                                strokeLinecap="round"
                              />
                            </svg>
                          </button>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </div>
              <div className="perf" aria-hidden="true">
                <span></span>
              </div>
              <div className="stub-body" style={{ paddingTop: 12 }}>
                <div className="total" style={{ marginBottom: 20 }}>
                  <span className="label" style={{ color: 'var(--muted)' }}>
                    Total
                  </span>
                  <b id="total">{fmt(total)}</b>
                </div>
                <button
                  type="button"
                  className="btn btn-amber btn-block"
                  id="hold-link"
                  hidden={n === 0}
                  disabled={holding}
                  onClick={() => void hold()}
                >
                  {holding ? 'Holding your seats…' : 'Hold these seats'}
                </button>
                <button
                  className="btn btn-block"
                  id="hold-disabled"
                  type="button"
                  disabled
                  hidden={n !== 0}
                >
                  Hold these seats
                </button>
                {notice ? (
                  <State tone="amber" role="alert">
                    {notice}
                  </State>
                ) : null}
                <p className="muted" style={{ margin: '14px 0 0', fontSize: 13 }}>
                  Held for ten minutes. You pay in the next step.
                </p>
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <SeatsPage />
    </Suspense>
  );
}
