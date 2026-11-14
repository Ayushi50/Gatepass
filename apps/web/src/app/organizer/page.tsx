'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Header, NAV } from '@/components/Header';
import { Loading, State } from '@/components/State';
import {
  api,
  ApiError,
  type ActivityItem,
  type OrganizerSummary,
  type RefundItem,
} from '@/lib/api';
import { useEvent } from '@/lib/events';
import { dateOf, fmtMinor, splitSeat, splitTitle, timeAgo } from '@/lib/format';
import { useRequireRole, useTick } from '@/lib/hooks';
import { openStream } from '@/lib/sse';
import '@/styles/organizer.css';

type FeedMessage = { kind: 'snapshot'; items: ActivityItem[] } | ({ kind: 'event' } & ActivityItem);
const FEED_MAX = 20;

function Organizer() {
  const eventId = useSearchParams().get('event') ?? 'neon-nights';
  const signedIn = useRequireRole('organizer');
  const event = useEvent(eventId);
  const now = useTick(5000);

  const [summary, setSummary] = useState<OrganizerSummary | null>(null);
  const [refunds, setRefunds] = useState<RefundItem[] | null>(null);
  const [feed, setFeed] = useState<ActivityItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState<string | null>(null);
  const refreshTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const refresh = useCallback(async () => {
    try {
      const [s, r] = await Promise.all([
        api<OrganizerSummary>(`/api/organizer/events/${eventId}/summary`),
        api<RefundItem[]>(`/api/organizer/events/${eventId}/refunds`),
      ]);
      setSummary(s);
      setRefunds(r);
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? 'forbidden'
          : err instanceof ApiError && err.status === 404
            ? 'not-found'
            : (err as Error).message,
      );
    }
  }, [eventId]);

  // The numbers refresh a moment after anything happens, not on every single event.
  const refreshSoon = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => void refresh(), 800);
  }, [refresh]);

  useEffect(() => {
    if (!signedIn) return;
    void refresh();
    const abort = new AbortController();
    void openStream<FeedMessage>(`/api/organizer/events/${eventId}/activity`, {
      signal: abort.signal,
      onRefused: () => undefined,
      onMessage: (m) => {
        if (m.kind === 'snapshot') {
          setFeed(m.items);
        } else {
          setFeed((prev) => {
            const { kind: _kind, ...item } = m;
            if ((prev ?? []).some((x) => x.id === item.id)) return prev; // already in the snapshot
            return [item, ...(prev ?? [])].slice(0, FEED_MAX);
          });
          refreshSoon();
        }
      },
    });
    return () => {
      abort.abort();
      clearTimeout(refreshTimer.current);
    };
  }, [signedIn, eventId, refresh, refreshSoon]);

  async function approve(id: string) {
    setApproving(id);
    try {
      await api(`/api/refunds/${id}/approve`, { method: 'POST' });
      setRefunds((list) =>
        (list ?? []).map((r) => (r.id === id ? { ...r, state: 'approved' } : r)),
      );
      refreshSoon();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setApproving(null);
    }
  }

  const title = summary?.title ?? event?.title ?? '';
  const [head, tail] = splitTitle(title);

  return (
    <div className="pg-organizer">
      <Header nav={[NAV.shows(), NAV.host(true), NAV.tickets()]} />
      <main>
        {error === 'forbidden' || error === 'not-found' ? (
          <div style={{ padding: '32px 48px' }}>
            <State
              tone="danger"
              role="alert"
              title={
                error === 'forbidden' ? 'This is not your show.' : 'We could not find that show.'
              }
            >
              {error === 'forbidden' ? 'Only its organizer can see its sales.' : null}
            </State>
          </div>
        ) : (
          <>
            <section className="head">
              <div>
                <p className="kicker">
                  {summary ? `Organizer · ${dateOf(summary.startsAt)}` : 'Organizer'}
                </p>
                <h1>
                  {head} <span className="italic">{tail}</span>
                </h1>
                <p className="muted" style={{ margin: 0, fontSize: 17 }}>
                  {event && summary
                    ? `${event.venue} · ${summary.total.toLocaleString('en-IN')} seats`
                    : ' '}
                </p>
              </div>
              <div className="chip">
                <span className="dot-live" aria-hidden="true"></span>
                <span>Live</span>
              </div>
            </section>

            {!summary && !error ? (
              <div style={{ padding: '0 48px' }}>
                <Loading>Loading the numbers…</Loading>
              </div>
            ) : null}
            {error && error !== 'forbidden' && error !== 'not-found' ? (
              <div style={{ padding: '0 48px' }}>
                <State tone="danger" role="alert" title="We could not load the numbers.">
                  {error}.
                  <br />
                  <button type="button" className="btn btn-ghost" onClick={() => void refresh()}>
                    Try again
                  </button>
                </State>
              </div>
            ) : null}

            <section className="tiles" aria-label="Summary">
              <div className="tile">
                <div className="label">Sold</div>
                <div className="n">
                  {summary?.sold.toLocaleString('en-IN') ?? '–'}{' '}
                  <small>{summary ? `of ${summary.total.toLocaleString('en-IN')}` : ''}</small>
                </div>
              </div>
              <div className="tile">
                <div className="label">Held right now</div>
                <div className="n">{summary?.held.toLocaleString('en-IN') ?? '–'}</div>
              </div>
              <div className="tile">
                <div className="label">Seats left</div>
                <div className="n">{summary?.left.toLocaleString('en-IN') ?? '–'}</div>
              </div>
              <div className="tile">
                <div className="label">Refund requests</div>
                <div className="n" id="refund-count">
                  {summary?.refundRequests ?? '–'}
                </div>
              </div>
            </section>

            <div className="grid">
              <section className="card">
                <p className="kicker">By tier</p>
                <h2>Where the seats went</h2>
                <div id="tiers">
                  {(summary?.tiers ?? []).map((t) => {
                    const pct = t.total ? Math.round((t.sold / t.total) * 100) : 0;
                    return (
                      <div className="bar-row" key={t.name}>
                        <div className="top">
                          <b>{t.name}</b>
                          <span className="muted">{`${t.sold} of ${t.total} · ${pct}%`}</span>
                        </div>
                        <div
                          className="bar"
                          role="img"
                          aria-label={`${t.name} tier ${pct} percent sold`}
                        >
                          <div style={{ width: `${pct}%` }}></div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>

              <section className="card">
                <p className="kicker">Needs you</p>
                <h2>Refund requests</h2>
                <div id="refunds">
                  {refunds && refunds.length === 0 ? (
                    <p className="muted" style={{ margin: 0, fontSize: 15 }}>
                      No refund requests. Nothing needs you.
                    </p>
                  ) : null}
                  {(refunds ?? []).map((r) => (
                    <div className="refund" key={r.id}>
                      <div className="who">
                        <b>{r.userId}</b>
                        <span>{`Row ${splitSeat(r.seatId).row} · seat ${splitSeat(r.seatId).number} · ${fmtMinor(r.amountMinor, r.currency)}`}</span>
                      </div>
                      {r.state === 'requested' ? (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={approving === r.id}
                          onClick={() => void approve(r.id)}
                        >
                          {approving === r.id ? 'Approving…' : 'Approve'}
                        </button>
                      ) : (
                        <span className="done">Approved ✓</span>
                      )}
                    </div>
                  ))}
                </div>
              </section>

              <section className="card" style={{ flexBasis: '100%' }}>
                <p className="kicker">Live activity</p>
                <h2>What is happening now</h2>
                {feed === null ? <Loading>Waiting for activity…</Loading> : null}
                {feed && feed.length === 0 ? (
                  <p className="muted" style={{ margin: 0, fontSize: 15 }}>
                    Nothing has happened yet.
                  </p>
                ) : null}
                <ul className="feed" id="feed" aria-live="polite">
                  {(feed ?? []).map((f) => (
                    <li key={f.id}>
                      <code className={f.failed ? 'bad' : ''}>{f.type}</code>
                      <span>{f.text}</span>
                      <time dateTime={f.at}>{timeAgo(f.at, now)}</time>
                    </li>
                  ))}
                </ul>
              </section>
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
      <Organizer />
    </Suspense>
  );
}
