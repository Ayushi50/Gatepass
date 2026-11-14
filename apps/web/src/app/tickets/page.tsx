'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Header, NAV } from '@/components/Header';
import { Qr } from '@/components/Qr';
import { Loading, State } from '@/components/State';
import { api, ApiError, type Ticket } from '@/lib/api';
import { dateTimeOf } from '@/lib/format';
import { useRequireRole } from '@/lib/hooks';
import { calendarFile } from '@/lib/ics';
import '@/styles/tickets.css';
import '@/styles/tickets-extra.css';

const TAG: Partial<Record<Ticket['status'], string>> = {
  refund_requested: 'REFUND REQUESTED',
  void: 'REFUNDED',
  used: 'USED',
};

export default function TicketsPage() {
  const signedIn = useRequireRole('attendee');
  const [tickets, setTickets] = useState<Ticket[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Record<string, string>>({});
  const [enlarged, setEnlarged] = useState<Ticket | null>(null);

  const load = useCallback(async () => {
    try {
      setTickets(await api<Ticket[]>('/api/tickets'));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);
  useEffect(() => {
    if (signedIn) void load();
  }, [signedIn, load]);

  async function refund(t: Ticket) {
    setBusy(t.id);
    setNotice((n) => ({ ...n, [t.id]: '' }));
    try {
      await api(`/api/tickets/${t.id}/refund`, { method: 'POST' });
      setTickets((list) =>
        (list ?? []).map((x) => (x.id === t.id ? { ...x, status: 'refund_requested' } : x)),
      );
    } catch (err) {
      const msg =
        err instanceof ApiError && err.status === 409
          ? 'This ticket can no longer be refunded.'
          : (err as Error).message;
      setNotice((n) => ({ ...n, [t.id]: msg }));
      void load();
    } finally {
      setBusy(null);
    }
  }

  function download(t: Ticket) {
    const url = URL.createObjectURL(new Blob([calendarFile(t)], { type: 'text/calendar' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${t.code}.ics`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="pg-tickets">
      <Header nav={[NAV.shows(), NAV.how(), NAV.host(), NAV.tickets(true)]} />
      <main className="wrap">
        <p className="kicker">Ready at the door</p>
        <h1>
          Your <span className="italic accent">tickets.</span>
        </h1>
        {tickets === null && !error ? <Loading>Loading your tickets…</Loading> : null}
        {error ? (
          <State tone="danger" role="alert" title="We could not load your tickets.">
            {error}.
            <br />
            <button type="button" className="btn btn-ghost" onClick={() => void load()}>
              Try again
            </button>
          </State>
        ) : null}
        {tickets && tickets.length === 0 ? (
          <State title="You have no tickets yet.">
            <Link href="/events">Find a show</Link>
          </State>
        ) : null}
        <div className="list" id="list">
          {(tickets ?? []).map((t) => (
            <article
              className={`ticket${t.status !== 'valid' ? ' refunded' : ''}`}
              key={t.id}
              aria-label={`Ticket, row ${t.row} seat ${t.seat}`}
            >
              <div className="ticket-main">
                <span className="tag">ADMIT ONE</span>
                <h2>{t.eventTitle}</h2>
                <p className="meta">{`${dateTimeOf(t.startsAt)} · ${t.venue}`}</p>
                <div className="cols">
                  <div>
                    <div className="k">Row</div>
                    <div className="v">{t.row}</div>
                  </div>
                  <div>
                    <div className="k">Seat</div>
                    <div className="v">{t.seat}</div>
                  </div>
                  <div>
                    <div className="k">Tier</div>
                    <div className="v">{t.tier}</div>
                  </div>
                </div>
                <div className="row-actions">
                  {t.status === 'valid' ? (
                    <button
                      type="button"
                      className="btn btn-ghost"
                      disabled={busy === t.id}
                      onClick={() => void refund(t)}
                    >
                      {busy === t.id ? 'Requesting…' : 'Request a refund'}
                    </button>
                  ) : (
                    <span className="tag" style={{ background: '#E7DFD2' }}>
                      {TAG[t.status]}
                    </span>
                  )}
                  <button type="button" className="btn btn-ghost" onClick={() => download(t)}>
                    Add to calendar
                  </button>
                </div>
                {notice[t.id] ? (
                  <p
                    role="alert"
                    style={{ margin: '14px 0 0', fontSize: 14, color: 'var(--ink-muted)' }}
                  >
                    {notice[t.id]}
                  </p>
                ) : null}
              </div>
              <div className="ticket-stubside">
                <button
                  type="button"
                  className="qr-btn"
                  onClick={() => setEnlarged(t)}
                  aria-label={`Enlarge the QR code for ticket ${t.code}`}
                >
                  <Qr value={t.qrToken} size={112} label={`QR code for ticket ${t.code}`} />
                </button>
                <span className="code">{t.code}</span>
              </div>
            </article>
          ))}
        </div>
      </main>
      {enlarged ? <Enlarged ticket={enlarged} onClose={() => setEnlarged(null)} /> : null}
    </div>
  );
}

function Enlarged({ ticket, onClose }: { ticket: Ticket; onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      className="qr-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`QR code for ticket ${ticket.code}`}
      onClick={onClose}
    >
      <div className="qr-sheet" onClick={(e) => e.stopPropagation()}>
        <div id="qr-large">
          <Qr value={ticket.qrToken} label={`Large QR code for ticket ${ticket.code}`} />
        </div>
        <span className="code">{ticket.code}</span>
        <button ref={close} type="button" className="btn btn-ghost" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
