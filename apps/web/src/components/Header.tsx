import Link from 'next/link';

export interface NavItem {
  href: string;
  label: string;
  current?: boolean;
  outline?: boolean;
}

const Logo = () => (
  <Link className="logo" href="/">
    <span>gatepass</span>
    <i aria-hidden="true"></i>
  </Link>
);

/** The site header with the main navigation (design: events, seats, tickets, organizer, index). */
export function Header({ nav }: { nav: NavItem[] }) {
  return (
    <header className="site-header">
      <Logo />
      <nav className="nav" aria-label="Main">
        {nav.map((n) => (
          <Link
            key={n.label}
            href={n.href}
            className={n.outline ? 'outline' : undefined}
            aria-current={n.current ? 'page' : undefined}
          >
            {n.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}

/** The header with the booking steps (design: checkout, status). */
export function StepsHeader({ current }: { current: 'pay' | 'tickets' }) {
  const bar = <li className="bar" aria-hidden="true"></li>;
  return (
    <header className="site-header">
      <Logo />
      <ol className="steps" aria-label="Booking steps">
        <li>Seats</li>
        {bar}
        <li aria-current={current === 'pay' ? 'step' : undefined}>Pay</li>
        {bar}
        <li
          aria-current={current === 'tickets' ? 'step' : undefined}
          style={current === 'pay' ? { color: 'var(--quiet)' } : undefined}
        >
          Tickets
        </li>
      </ol>
    </header>
  );
}

export const NAV = {
  shows: (current = false): NavItem => ({ href: '/events', label: 'Shows', current }),
  how: (): NavItem => ({ href: '/#how', label: 'How it works' }),
  host: (current = false): NavItem => ({ href: '/organizer', label: 'Host a show', current }),
  tickets: (current = false): NavItem => ({
    href: '/tickets',
    label: 'My tickets',
    outline: true,
    current,
  }),
};
