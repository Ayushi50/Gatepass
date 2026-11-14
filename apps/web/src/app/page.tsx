import Link from 'next/link';
import { Header, NAV } from '@/components/Header';
import '@/styles/index.css';

/** The decorative auditorium: rows widen away from the stage, arcs curve toward it. Pure of (row, col). */
function SeatField() {
  const rows = [];
  for (let r = 0; r < 11; r++) {
    const count = 12 + r * 2;
    const seats = [];
    for (let c = 0; c < count; c++) {
      const x = c - (count - 1) / 2;
      const ty = -Math.round(x * x * 0.11);
      const h = (r * 31 + c * 17 + ((r * c) % 5)) % 9;
      const mine = r === 6 && c === Math.floor(count / 2);
      let cls = 'fseat';
      if (h === 1 || h === 2) cls += ' taken';
      if (h === 0) cls += ' lit';
      if (mine) cls = 'fseat mine';
      seats.push(
        <div key={c} className={cls} style={{ transform: `translateY(${ty}px)` }}>
          {mine ? <span className="yours">Row G · Seat 7 · yours</span> : null}
        </div>,
      );
    }
    rows.push(
      <div key={r} className="frow" style={{ opacity: (1 - r * 0.03).toFixed(2) }}>
        {seats}
      </div>,
    );
  }
  return (
    <div
      className="seat-field"
      id="seat-field"
      role="img"
      aria-label="An auditorium seat map with one seat lit up for you"
    >
      {rows}
    </div>
  );
}

export default function Home() {
  return (
    <div className="pg-index">
      <Header
        nav={[NAV.shows(), { href: '#how', label: 'How it works' }, NAV.host(), NAV.tickets()]}
      />
      <main>
        <section className="hero">
          <p className="kicker">Live events · seat by seat</p>
          <h1>
            Find your seat <span className="italic accent">in the dark.</span>
          </h1>
          <p className="lead">
            The lights go down and your seat is already yours. Gatepass holds it for ten minutes
            while you pay, so nobody takes it from under you.
          </p>
          <div className="actions">
            <Link className="btn btn-amber" href="/events">
              Choose a show
            </Link>
            <a className="link" href="#how">
              How it works →
            </a>
          </div>
        </section>

        <section className="auditorium" aria-label="Auditorium seat map illustration">
          <div className="stage-glow" aria-hidden="true"></div>
          <div className="stage-line" aria-hidden="true"></div>
          <p className="stage-label" aria-hidden="true">
            STAGE
          </p>
          <SeatField />
        </section>

        <section className="how" id="how">
          <div>
            <div className="num">i.</div>
            <h2>Held for ten minutes.</h2>
            <p>Choose your seats and breathe. They are yours while you pay.</p>
          </div>
          <div>
            <div className="num">ii.</div>
            <h2>One seat, one buyer.</h2>
            <p>If someone else is mid-checkout, you see it before you click.</p>
          </div>
          <div>
            <div className="num">iii.</div>
            <h2>Your ticket, in your pocket.</h2>
            <p>A QR code at the door. Need to cancel? Request a refund from the ticket itself.</p>
          </div>
        </section>
      </main>

      <footer className="site-footer">
        <span className="mark">gatepass</span>
        <span className="muted" style={{ fontSize: 13 }}>
          Shows, seat by seat.
        </span>
      </footer>
    </div>
  );
}
