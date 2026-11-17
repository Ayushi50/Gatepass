'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { StepsHeader } from '@/components/Header';
import { StripeCardFields } from '@/components/StripeCard';
import { Loading, State } from '@/components/State';
import { api, ApiError, type Booking, type Seat } from '@/lib/api';
import { useEvent } from '@/lib/events';
import { clock, dateTimeOf, fmt, fmtMinor, sortSeats, splitSeat, splitTitle } from '@/lib/format';
import { clockSkew, secondsLeft } from '@/lib/hold';
import { useRequireRole } from '@/lib/hooks';
import { GATEWAY_METHOD, testToken, type PayMethod } from '@/lib/payment';
import { payWithRazorpay } from '@/lib/razorpay';
import { idempotencyKeyFor } from '@/lib/storage';
import '@/styles/checkout.css';

const HOLD_SECONDS = Number(process.env.NEXT_PUBLIC_HOLD_SECONDS ?? 600);
const METHODS: { id: PayMethod; name: string; hint: string }[] = [
  { id: 'upi', name: 'UPI', hint: 'Any UPI app' },
  { id: 'card', name: 'Card', hint: 'Credit or debit' },
  { id: 'net', name: 'Netbanking', hint: 'Pay through your bank' },
];
const field: React.CSSProperties = {
  width: '100%',
  height: 54,
  padding: '0 18px',
  background: 'var(--panel)',
  border: '1px solid var(--outline)',
  borderRadius: 14,
  color: 'var(--text)',
  font: '16px var(--font-ui)',
};
const label: React.CSSProperties = {
  display: 'block',
  marginBottom: 8,
  fontSize: 14,
  fontWeight: 600,
};

const CANCELLED_COPY: Record<string, string> = {
  hold_expired: 'Your seats were released so others can book them.',
  payment_failed:
    'That payment did not go through, and nothing was charged. Your seats were released so others can book them.',
  hold_failed: 'Someone else got those seats first.',
};

function Checkout() {
  const router = useRouter();
  const bookingId = useSearchParams().get('booking') ?? '';
  const signedIn = useRequireRole('attendee');

  const [booking, setBooking] = useState<Booking | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [skew, setSkew] = useState(0); // server clock minus this browser's clock, in ms
  const [now, setNow] = useState(() => Date.now());
  const [seats, setSeats] = useState<Seat[]>([]);
  const event = useEvent(booking?.eventId ?? '');

  // which payment provider is live: with Stripe, only cards, typed into Stripe's own fields
  const [stripeKey, setStripeKey] = useState<string | null>(null);
  // with Razorpay, its own window takes the payment details
  const [razorpayKey, setRazorpayKey] = useState<string | null>(null);
  const makePaymentMethod = useRef<(() => Promise<string>) | null>(null);
  useEffect(() => {
    api<{ provider: string; publishableKey?: string }>('/api/payments/config', {
      auth: false,
    }).then(
      (c) => {
        if (c.provider === 'stripe' && c.publishableKey) {
          setStripeKey(c.publishableKey);
          setMethod('card');
        }
      },
      () => undefined,
    );
  }, []);

  const [method, setMethod] = useState<PayMethod>('upi');
  const [upi, setUpi] = useState('');
  const [card, setCard] = useState('');
  const [exp, setExp] = useState('');
  const [cvc, setCvc] = useState('');
  const [paying, setPaying] = useState(false);
  const [payError, setPayError] = useState<string | null>(null);
  const [expiredByServer, setExpiredByServer] = useState(false);
  const lastBooking = useRef<Booking | null>(null);

  const refresh = useCallback(async () => {
    try {
      const b = await api<Booking>(`/api/bookings/${bookingId}`);
      setSkew(clockSkew(b.serverTime, Date.now())); // the countdown follows the SERVER's clock
      lastBooking.current = b;
      setBooking(b);
      setLoadError(null);
      return b;
    } catch (err) {
      setLoadError(
        err instanceof ApiError && err.status === 404 ? 'not-found' : (err as Error).message,
      );
      return null;
    }
  }, [bookingId]);

  useEffect(() => {
    if (!signedIn || !bookingId) return;
    void refresh();
    const t = setInterval(() => {
      const b = lastBooking.current;
      if (!b || b.state === 'REQUESTED') void refresh();
    }, 1000);
    return () => clearInterval(t);
  }, [signedIn, bookingId, refresh]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!booking) return;
    if (booking.state === 'PAID' || booking.state === 'CONFIRMED')
      router.replace(`/status?booking=${bookingId}`);
    api<Seat[]>(`/api/events/${booking.eventId}/seats`, { auth: false }).then(
      setSeats,
      () => undefined,
    );
  }, [booking?.state, booking?.eventId]); // eslint-disable-line react-hooks/exhaustive-deps

  const remaining = booking?.holdExpiresAt
    ? Math.max(0, Math.floor((Date.parse(booking.holdExpiresAt) - (now + skew)) / 1000))
    : HOLD_SECONDS;
  const cancelled = booking?.state === 'CANCELLED';
  const gone = cancelled || expiredByServer || (booking?.state === 'HELD' && remaining === 0);
  const waitingForHold = !booking || booking.state === 'REQUESTED';

  const items = sortSeats(booking?.seatIds ?? []).map((id) => ({
    id,
    seat: seats.find((s) => s.id === id),
  }));
  const total = booking?.amountMinor
    ? fmtMinor(booking.amountMinor, booking.currency ?? 'INR')
    : fmt(items.reduce((s, i) => s + (i.seat?.price ?? 0), 0));

  async function pay() {
    if (!booking || paying || gone) return;
    setPayError(null);
    if (method === 'upi' && !/^[^\s@]+@[^\s@]+$/.test(upi.trim()))
      return setPayError('Enter your UPI ID, like name@bank.');
    if (!stripeKey && method === 'card' && card.replace(/\D/g, '').length < 12)
      return setPayError('Enter your card number.');
    if (stripeKey && !makePaymentMethod.current)
      return setPayError('The card form is still loading. Try again in a moment.');
    setPaying(true);
    try {
      const token = razorpayKey
        ? 'razorpay_checkout'
        : stripeKey
          ? await makePaymentMethod.current!()
          : testToken(method, { upi, card });
      const started = await api<{ status: string; providerRef?: string }>(
        `/api/bookings/${booking.id}/pay`,
        {
          method: 'POST',
          body: { method: razorpayKey ? 'upi' : GATEWAY_METHOD[method], token },
          headers: { 'idempotency-key': idempotencyKeyFor(booking.id) },
        },
      );
      if (razorpayKey && started.status === 'processing' && started.providerRef) {
        const done = await payWithRazorpay({ keyId: razorpayKey, orderId: started.providerRef });
        if (!done) return setPaying(false); // closed the window: the same order reopens on the next click
        await api(`/api/bookings/${booking.id}/pay/confirm`, { method: 'POST', body: done });
      }
      router.push(`/status?booking=${booking.id}`);
    } catch (err) {
      setPaying(false);
      if (err instanceof ApiError && err.status === 409) {
        if (err.code === 'payment_in_progress') return router.push(`/status?booking=${booking.id}`);
        setExpiredByServer(true);
        return void refresh();
      }
      setPayError(
        err instanceof ApiError && err.offline
          ? 'We could not reach the server. Nothing was charged: try again.'
          : (err as Error).message,
      );
    }
  }

  const [titleHead, titleTail] = splitTitle(event?.title ?? '');

  return (
    <div className="pg-checkout">
      <StepsHeader current="pay" />
      <main className="layout">
        {loadError === 'not-found' ? (
          <State title="We could not find that booking.">
            <Link href="/events">Back to the shows</Link>
          </State>
        ) : (
          <>
            <section className="pay">
              <p className="kicker">
                {cancelled ? 'This booking is closed' : 'Your seats are held'}
              </p>
              <h1>
                Almost <span className="italic accent">yours.</span>
              </h1>

              {loadError ? (
                <State tone="danger" role="alert" title="We could not load your booking.">
                  {loadError}.
                  <br />
                  <button type="button" className="btn btn-ghost" onClick={() => void refresh()}>
                    Try again
                  </button>
                </State>
              ) : null}
              {waitingForHold && !loadError ? <Loading>Holding your seats…</Loading> : null}

              <div className="clock">
                <div className="top">
                  <span className="muted" style={{ fontSize: 14 }}>
                    Time left to pay
                  </span>
                  <span className="time" id="time" role="timer" aria-live="off">
                    {clock(gone ? 0 : remaining)}
                  </span>
                </div>
                <div className="track" aria-hidden="true">
                  <div
                    id="progress"
                    style={{
                      width: `${gone ? 0 : Math.min(100, Math.round((remaining / HOLD_SECONDS) * 100))}%`,
                    }}
                  ></div>
                </div>
              </div>

              <div className="expired" id="expired" hidden={!gone}>
                <strong style={{ fontWeight: 600 }}>The lights are back up.</strong>{' '}
                {CANCELLED_COPY[booking?.cancelReason ?? 'hold_expired'] ??
                  CANCELLED_COPY.hold_expired}{' '}
                <Link
                  href={booking ? `/seats?event=${booking.eventId}` : '/events'}
                  style={{ fontWeight: 600 }}
                >
                  Pick new seats
                </Link>
              </div>

              {razorpayKey ? (
                <p
                  className="muted"
                  style={{
                    margin: '22px 0 0',
                    padding: '16px 18px',
                    border: '1px dashed var(--outline)',
                    borderRadius: 14,
                    fontSize: 15,
                    lineHeight: 1.5,
                  }}
                >
                  You will choose UPI, card or netbanking in Razorpay&apos;s secure window.
                </p>
              ) : (
                <>
                  <h2 className="sub">How would you like to pay?</h2>
                  <div
                    className="methods"
                    role="radiogroup"
                    aria-label="Payment method"
                    id="methods"
                  >
                    {METHODS.filter((m) => !stripeKey || m.id === 'card').map((m) => (
                      <button
                        key={m.id}
                        type="button"
                        className="radio-card"
                        role="radio"
                        aria-checked={m.id === method}
                        onClick={() => setMethod(m.id)}
                      >
                        <span className="ring" aria-hidden="true"></span>
                        <span>
                          <span className="name">{m.name}</span>
                          <span className="hint">{m.hint}</span>
                        </span>
                      </button>
                    ))}
                  </div>

                  <div id="panel-upi" className="field" hidden={method !== 'upi'}>
                    <label htmlFor="upi-id">UPI ID</label>
                    <input
                      id="upi-id"
                      type="text"
                      placeholder="name@bank"
                      autoComplete="off"
                      value={upi}
                      onChange={(e) => setUpi(e.target.value)}
                    />
                    <p className="hint">You will get a request in your UPI app to approve.</p>
                  </div>
                  <div id="panel-card" className="field" hidden={method !== 'card'}>
                    {stripeKey ? (
                      <StripeCardFields
                        publishableKey={stripeKey}
                        onReady={(fn) => (makePaymentMethod.current = fn)}
                        onError={setPayError}
                      />
                    ) : (
                      <>
                        <label htmlFor="card-no">Card number</label>
                        <input
                          id="card-no"
                          type="text"
                          inputMode="numeric"
                          placeholder="0000 0000 0000 0000"
                          autoComplete="off"
                          value={card}
                          onChange={(e) => setCard(e.target.value)}
                        />
                        <div className="field-row" style={{ marginTop: 14 }}>
                          <div>
                            <label htmlFor="card-exp" style={label}>
                              Expiry
                            </label>
                            <input
                              id="card-exp"
                              type="text"
                              placeholder="MM / YY"
                              style={field}
                              value={exp}
                              onChange={(e) => setExp(e.target.value)}
                            />
                          </div>
                          <div>
                            <label htmlFor="card-cvc" style={label}>
                              CVC
                            </label>
                            <input
                              id="card-cvc"
                              type="text"
                              placeholder="123"
                              style={field}
                              value={cvc}
                              onChange={(e) => setCvc(e.target.value)}
                            />
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                  <p
                    id="panel-net"
                    className="muted"
                    hidden={method !== 'net'}
                    style={{
                      margin: '22px 0 0',
                      padding: '16px 18px',
                      border: '1px dashed var(--outline)',
                      borderRadius: 14,
                      fontSize: 15,
                      lineHeight: 1.5,
                    }}
                  >
                    You will be sent to your bank to finish paying, then brought straight back here.
                  </p>
                </>
              )}

              {payError ? (
                <State tone="danger" role="alert">
                  {payError}
                </State>
              ) : null}

              <button
                className="btn btn-amber btn-block"
                id="pay-btn"
                type="button"
                style={{ marginTop: 30, minHeight: 60, fontSize: 17 }}
                hidden={gone}
                disabled={paying || waitingForHold}
                onClick={() => void pay()}
              >
                {paying ? 'Paying…' : `Pay ${total}`}
              </button>
              <button
                className="btn btn-block"
                id="pay-off"
                type="button"
                disabled
                hidden={!gone}
                style={{ marginTop: 30, minHeight: 60, fontSize: 17 }}
              >
                {`Pay ${total}`}
              </button>

              <div className="pay-actions">
                <span className="test-tag">Test mode · no real money moves</span>
                <Link
                  href={booking ? `/seats?event=${booking.eventId}` : '/events'}
                  style={{ fontSize: 14, fontWeight: 600 }}
                >
                  Back to seats
                </Link>
              </div>
            </section>

            <aside>
              <div className="stub">
                <div className="stub-body" style={{ paddingBottom: 22 }}>
                  <p className="kicker">{event ? dateTimeOf(event.startsAt) : ' '}</p>
                  <h2>
                    {titleHead} <span className="italic">{titleTail}</span>
                  </h2>
                  <p className="muted" style={{ margin: '0 0 18px', fontSize: 14 }}>
                    {event?.venue ?? ' '}
                  </p>
                  <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                    {items.map(({ id, seat }) => (
                      <li className="line-item" key={id}>
                        <div>
                          <div className="t">{`Row ${splitSeat(id).row}, seat ${splitSeat(id).number}`}</div>
                          <div className="s">{seat ? `${seat.tier} tier` : ' '}</div>
                        </div>
                        <span className="t">{seat ? fmt(seat.price) : ''}</span>
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="perf" aria-hidden="true">
                  <span></span>
                </div>
                <div className="stub-body" style={{ paddingTop: 12 }}>
                  <div className="total">
                    <span className="label">Total</span>
                    <b>{total}</b>
                  </div>
                </div>
              </div>
            </aside>
          </>
        )}
      </main>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <Checkout />
    </Suspense>
  );
}
