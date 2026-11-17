'use client';
import { useEffect, useRef } from 'react';

/* eslint-disable @typescript-eslint/no-explicit-any -- Stripe.js is loaded from stripe.com, untyped here */
declare global {
  interface Window {
    Stripe?: (key: string) => any;
  }
}

let loading: Promise<void> | undefined;
/** Loads Stripe.js from Stripe itself (it must never be bundled or self-hosted). */
function loadStripeJs(): Promise<void> {
  if (window.Stripe) return Promise.resolve();
  loading ??= new Promise<void>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://js.stripe.com/v3/';
    s.onload = () => resolve();
    s.onerror = () => {
      loading = undefined;
      reject(new Error('Could not load the card form. Check your connection and try again.'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

const box: React.CSSProperties = {
  height: 54,
  padding: '0 18px',
  display: 'flex',
  alignItems: 'center',
  background: 'var(--panel)',
  border: '1px solid var(--outline)',
  borderRadius: 14,
};
const lbl: React.CSSProperties = {
  display: 'block',
  marginBottom: 8,
  fontSize: 14,
  fontWeight: 600,
};
const STYLE = {
  base: { color: '#f5efe6', fontSize: '16px', '::placeholder': { color: '#8d8296' } },
  invalid: { color: '#ff8a80' },
};

/**
 * Stripe's own card fields. Card details go from these fields straight to Stripe; this app only
 * ever receives a one-time PaymentMethod id (`pm_...`), which `onReady`'s function returns.
 */
export function StripeCardFields({
  publishableKey,
  onReady,
  onError,
}: {
  publishableKey: string;
  onReady: (createPaymentMethod: () => Promise<string>) => void;
  onError: (message: string) => void;
}) {
  const number = useRef<HTMLDivElement>(null);
  const expiry = useRef<HTMLDivElement>(null);
  const cvc = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    const mounted: any[] = [];
    loadStripeJs().then(
      () => {
        if (cancelled) return;
        const stripe = window.Stripe!(publishableKey);
        const elements = stripe.elements();
        const n = elements.create('cardNumber', { style: STYLE, showIcon: false });
        const e = elements.create('cardExpiry', { style: STYLE });
        const c = elements.create('cardCvc', { style: STYLE });
        n.mount(number.current);
        e.mount(expiry.current);
        c.mount(cvc.current);
        mounted.push(n, e, c);
        onReady(async () => {
          const res = await stripe.createPaymentMethod({ type: 'card', card: n });
          if (res.error) throw new Error(res.error.message ?? 'Check your card details.');
          return res.paymentMethod.id as string;
        });
      },
      (err: Error) => onError(err.message),
    );
    return () => {
      cancelled = true;
      mounted.forEach((m) => m.destroy());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once per key
  }, [publishableKey]);

  return (
    <>
      <label style={lbl}>Card number</label>
      <div ref={number} style={box} id="stripe-card-number" />
      <div className="field-row" style={{ marginTop: 14 }}>
        <div>
          <label style={lbl}>Expiry</label>
          <div ref={expiry} style={box} />
        </div>
        <div>
          <label style={lbl}>CVC</label>
          <div ref={cvc} style={box} />
        </div>
      </div>
    </>
  );
}
