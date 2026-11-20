'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Header, NAV } from '@/components/Header';
import { Loading, State } from '@/components/State';
import { api, type EventListItem } from '@/lib/api';
import { dayMonth, fmt, timeOf } from '@/lib/format';
import { useRequireSignIn } from '@/lib/hooks';
import '@/styles/events.css';

const KNOWN_CATEGORIES = ['Music', 'Comedy', 'Festivals'];
/** The list says "Festival" under a "Festivals" filter, as in the design. */
const SINGULAR: Record<string, string> = { Festivals: 'Festival' };

const STATUS_TEXT = { selling_fast: 'Selling fast', available: 'Seats available' } as const;

export default function EventsPage() {
  const signedIn = useRequireSignIn();
  const [shows, setShows] = useState<EventListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('All');

  const load = useCallback(async () => {
    setError(null);
    try {
      setShows(await api<EventListItem[]>('/api/events', { auth: false }));
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  const categories = [
    'All',
    ...KNOWN_CATEGORIES,
    ...[...new Set((shows ?? []).map((s) => s.category))].filter(
      (c) => !KNOWN_CATEGORIES.includes(c),
    ),
  ];
  const visible = (shows ?? []).filter((s) => filter === 'All' || s.category === filter);

  return (
    <div className="pg-events">
      <Header nav={[NAV.shows(true), NAV.how(), NAV.host(), NAV.tickets()]} />
      <main>
        <section className="intro">
          <p className="kicker">Now on sale</p>
          <h1>
            What is <span className="italic accent">on.</span>
          </h1>
          <div className="filters" role="group" aria-label="Filter shows by type" id="filters">
            {categories.map((c) => (
              <button
                key={c}
                type="button"
                className="pill"
                aria-pressed={c === filter}
                onClick={() => setFilter(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </section>
        <section className="shows" aria-live="polite">
          {shows === null && !error ? <Loading>Loading shows…</Loading> : null}
          {error ? (
            <State tone="danger" title="We could not load the shows." role="alert">
              {error}.
              <br />
              <button type="button" className="btn btn-ghost" onClick={() => void load()}>
                Try again
              </button>
            </State>
          ) : null}
          {shows && visible.length === 0 ? (
            <State
              title={
                filter === 'All'
                  ? 'Nothing is on sale right now.'
                  : `No ${filter.toLowerCase()} shows right now.`
              }
            >
              Check back soon.
            </State>
          ) : null}
          {shows && visible.length > 0 ? (
            <ul id="show-list">
              {visible.map((s) => (
                <ShowRow key={s.id} show={s} />
              ))}
            </ul>
          ) : null}
        </section>
      </main>
    </div>
  );
}

function ShowRow({ show: s }: { show: EventListItem }) {
  const { day, month } = dayMonth(s.startsAt);
  const date = (
    <div className="date">
      <div className="day">{day}</div>
      <div className="month">{month}</div>
    </div>
  );
  const info = (
    <div className="info">
      <h2>{s.title}</h2>
      <p className="meta">{`${SINGULAR[s.category] ?? s.category} · ${timeOf(s.startsAt)} · ${s.venue}`}</p>
    </div>
  );
  if (s.status === 'sold_out' || s.status === 'unavailable') {
    return (
      <li>
        <div className="show sold">
          {date}
          {info}
          <div className="side">
            <span className="sold-badge">
              {s.status === 'sold_out' ? 'Sold out' : 'Not on sale yet'}
            </span>
          </div>
          <div style={{ width: 28 }}></div>
        </div>
      </li>
    );
  }
  const dot = s.status === 'selling_fast' ? 'fast' : 'ok';
  return (
    <li>
      <Link
        className="show"
        href={s.waitingRoom ? `/waiting-room?event=${s.id}` : `/seats?event=${s.id}`}
      >
        {date}
        {info}
        <div className="side">
          <span className="status">
            <i className={dot} aria-hidden="true"></i>
            {STATUS_TEXT[s.status]}
          </span>
          <span className="muted" style={{ fontSize: 14 }}>{`From ${fmt(s.minPrice)}`}</span>
        </div>
        <svg
          className="arrow"
          width="28"
          height="28"
          viewBox="0 0 28 28"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M5 14h18M16 7l7 7-7 7"
            stroke="#FFB347"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </Link>
    </li>
  );
}
