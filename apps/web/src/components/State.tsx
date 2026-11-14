import type { ReactNode } from 'react';

/** A bordered notice in the design's own `.expired`/dashed-card language. */
export function State({
  tone,
  title,
  children,
  role,
}: {
  tone?: 'amber' | 'danger';
  title?: string;
  children?: ReactNode;
  role?: 'status' | 'alert';
}) {
  return (
    <div className="state" data-tone={tone} role={role}>
      {title ? <strong>{title} </strong> : null}
      {children}
    </div>
  );
}

export function Loading({ children = 'Loading…' }: { children?: ReactNode }) {
  return (
    <div className="loading" role="status">
      <span className="dot-live" aria-hidden="true"></span>
      <span>{children}</span>
    </div>
  );
}
