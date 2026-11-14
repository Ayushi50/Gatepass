'use client';
import { useEffect, useState } from 'react';
import { api, type EventListItem } from './api';
import { readSession, removeSession, admissionKey } from './storage';

/** The show with this id, from the public list (null until loaded, undefined if there is no such show). */
export function useEvent(eventId: string): EventListItem | null | undefined {
  const [event, setEvent] = useState<EventListItem | null | undefined>(null);
  useEffect(() => {
    let live = true;
    api<EventListItem[]>('/api/events', { auth: false })
      .then((list) => live && setEvent(list.find((e) => e.id === eventId)))
      .catch(() => live && setEvent(undefined));
    return () => {
      live = false;
    };
  }, [eventId]);
  return event;
}

/** The admission pass for a waiting-room show, or null if there is none or it has run out. */
export function admissionToken(eventId: string, now: number = Date.now()): string | null {
  const token = readSession(admissionKey(eventId));
  if (!token) return null;
  try {
    const payload = JSON.parse(
      atob((token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')),
    );
    if (typeof payload.exp === 'number' && payload.exp * 1000 > now) return token;
  } catch {
    /* fall through: unreadable means unusable */
  }
  removeSession(admissionKey(eventId));
  return null;
}
