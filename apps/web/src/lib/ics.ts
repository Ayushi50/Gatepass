/** A calendar file for one ticket, made in the browser. */
export function calendarFile(
  t: { eventTitle: string; startsAt: string; venue: string; code: string },
  hours = 3,
): string {
  const stamp = (d: Date) =>
    d
      .toISOString()
      .replace(/[-:]/g, '')
      .replace(/\.\d{3}/, '');
  const start = new Date(t.startsAt);
  const esc = (s: string) => s.replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Gatepass//EN',
    'BEGIN:VEVENT',
    `UID:${t.code}@gatepass`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(start)}`,
    `DTEND:${stamp(new Date(start.getTime() + hours * 3600_000))}`,
    `SUMMARY:${esc(t.eventTitle)}`,
    `LOCATION:${esc(t.venue)}`,
    `DESCRIPTION:${esc(`Ticket ${t.code}`)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}
