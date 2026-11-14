'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type CheckInResult } from '@/lib/api';
import { useEvent } from '@/lib/events';
import { timeOf } from '@/lib/format';
import { useRequireRole } from '@/lib/hooks';
import { startScanner } from '@/lib/scanner';
import '@/styles/check-in.css';
import '@/styles/check-in-extra.css';

type Mode = 'ready' | 'valid' | 'used' | 'invalid' | 'error';

const TICK = (
  <svg width="22" height="22" viewBox="0 0 14 14" fill="none" aria-hidden="true">
    <path
      d="M2.5 7.5l3 3 6-7"
      stroke="#0D0A10"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);
const CROSS = (
  <svg width="20" height="20" viewBox="0 0 12 12" fill="none" aria-hidden="true">
    <path d="M2 2l8 8M10 2l-8 8" stroke="#FF8A97" strokeWidth="1.8" strokeLinecap="round" />
  </svg>
);
const DOT = (
  <span
    style={{
      width: 10,
      height: 10,
      borderRadius: '50%',
      background: 'var(--amber)',
      display: 'block',
      animation: 'livepulse 2s ease-in-out infinite',
    }}
  ></span>
);

interface View {
  mode: Mode;
  detail?: string;
}

function copyFor(v: View): { k: string; t: React.ReactNode; p: string; icon: React.ReactNode } {
  switch (v.mode) {
    case 'valid':
      return {
        k: 'Valid ticket',
        t: (
          <>
            Welcome <span className="italic accent">in.</span>
          </>
        ),
        p: `${v.detail} Marked as used.`,
        icon: TICK,
      };
    case 'used':
      return {
        k: 'Do not admit',
        t: (
          <>
            Already{' '}
            <span className="italic" style={{ color: 'var(--danger)' }}>
              used.
            </span>
          </>
        ),
        p: v.detail ?? 'This ticket was already scanned.',
        icon: CROSS,
      };
    case 'invalid':
      return {
        k: 'Do not admit',
        t: (
          <>
            Not a valid{' '}
            <span className="italic" style={{ color: 'var(--danger)' }}>
              ticket.
            </span>
          </>
        ),
        p: 'This code is not a Gatepass ticket, or the ticket was refunded.',
        icon: CROSS,
      };
    case 'error':
      return {
        k: 'Try again',
        t: (
          <>
            Could not <span className="italic accent">check.</span>
          </>
        ),
        p: v.detail ?? 'We could not reach the server. Scan again in a moment.',
        icon: CROSS,
      };
    default:
      return {
        k: 'Ready',
        t: (
          <>
            Waiting for a <span className="italic accent">ticket.</span>
          </>
        ),
        p: 'Hold the camera steady over the QR code.',
        icon: DOT,
      };
  }
}

function CheckIn() {
  const params = useSearchParams();
  const gate = params.get('gate') ?? '1';
  const event = useEvent(params.get('event') ?? 'neon-nights');
  const signedIn = useRequireRole('door-staff');

  const video = useRef<HTMLVideoElement>(null);
  const [cameraOk, setCameraOk] = useState<boolean | null>(null);
  const [view, setView] = useState<View>({ mode: 'ready' });
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const last = useRef<{ token: string; at: number } | null>(null);

  const check = useCallback(async (qrToken: string) => {
    setBusy(true);
    try {
      const r = await api<CheckInResult>('/api/checkin', { method: 'POST', body: { qrToken } });
      if (r.status === 'valid')
        setView({ mode: 'valid', detail: `Row ${r.row} · Seat ${r.seat} · ${r.tier} tier.` });
      else setView({ mode: 'invalid' });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const usedAt = (err.body as { usedAt?: string } | undefined)?.usedAt;
        setView({
          mode: 'used',
          detail: usedAt ? `This ticket was already scanned at ${timeOf(usedAt)}.` : undefined,
        });
      } else if (err instanceof ApiError && err.status === 404) setView({ mode: 'invalid' });
      else
        setView({
          mode: 'error',
          detail: err instanceof ApiError && err.offline ? undefined : (err as Error).message,
        });
    } finally {
      setBusy(false);
    }
  }, []);

  /** The camera sees a code many times a second; one scan is checked once, until it has been away. */
  const onToken = useCallback(
    (token: string) => {
      const now = Date.now();
      if (last.current && last.current.token === token && now - last.current.at < 4000) {
        last.current.at = now;
        return;
      }
      last.current = { token, at: now };
      void check(token);
    },
    [check],
  );

  useEffect(() => {
    if (!signedIn || !video.current) return;
    let scanner: { stop(): void } | undefined;
    let cancelled = false;
    startScanner(video.current, onToken).then(
      (s) => {
        if (cancelled) s.stop();
        else {
          scanner = s;
          setCameraOk(true);
        }
      },
      () => !cancelled && setCameraOk(false),
    );
    return () => {
      cancelled = true;
      scanner?.stop();
    };
  }, [signedIn, onToken]);

  const c = copyFor(view);

  return (
    <div className="pg-check-in">
      <div className="phone">
        <div className="top">
          <Link className="logo" href="/">
            <span>gatepass</span>
            <i aria-hidden="true"></i>
          </Link>
          <span className="where">{`Gate ${gate} · ${event?.title ?? ''}`}</span>
        </div>

        <div
          className="viewfinder"
          role="img"
          aria-label="Camera viewfinder. Point it at a ticket QR code."
        >
          <video ref={video} muted playsInline hidden={!cameraOk}></video>
          <span className="corner c1"></span>
          <span className="corner c2"></span>
          <span className="corner c3"></span>
          <span className="corner c4"></span>
          <span className="scan"></span>
          <span className="hint">
            {cameraOk === false
              ? 'Camera unavailable. Type the code below.'
              : 'Point at the ticket QR code'}
          </span>
        </div>

        <form
          className="manual preview"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim()) {
              last.current = null;
              void check(code.trim()).then(() => setCode(''));
            }
          }}
        >
          <input
            type="text"
            aria-label="Ticket code"
            placeholder="Or type the ticket code"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <button type="submit" className="btn btn-ghost" disabled={busy || !code.trim()}>
            Check
          </button>
        </form>

        <section
          className="result"
          id="result"
          aria-live="assertive"
          data-m={view.mode}
          style={{ display: 'flex' }}
        >
          <span className="badge">{c.icon}</span>
          <h1>{c.t}</h1>
          <p className="kicker" style={{ order: -1, margin: '14px 0 0' }}>
            {c.k}
          </p>
          <p>{c.p}</p>
        </section>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={null}>
      <CheckIn />
    </Suspense>
  );
}
