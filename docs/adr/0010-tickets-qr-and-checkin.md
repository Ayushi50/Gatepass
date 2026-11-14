# ADR 0010: Signed QR tokens and atomic check-in

## Context

Staff scan a QR at the door. Two gates can scan the same code at the same moment, and exactly one may be admitted. A forged code must never be admitted.

## Decision

**Tickets.** The ticket service keeps its own copy of the show and seat map (from `event.published`) and, on `booking.confirmed`, issues one ticket per seat and publishes `ticket.issued` in the same transaction. `UNIQUE (booking_id, seat_id)` makes issuing idempotent. If it has not seen the show or a seat it throws (retry, then dead-letter) instead of issuing a ticket with guessed details.

**QR token.** `GP1.<payload>.<signature>`: the payload is `{ticketId, eventId, keyId}` only (no name, email, seat or price) and the signature is HMAC-SHA256 over `GP1.<payload>`. `TICKET_SIGNING_KEYS=kid:secret,...` lists keys: the first signs, any verifies, so a key can be rotated without invalidating tickets already sold. Secrets must be 32+ characters. Verification is constant-time. Only the ticket service ever verifies a token, so a shared secret is enough; asymmetric keys would only matter for offline scanners. The token is signed on read, not stored, so rotating the signing key re-signs every ticket the next time it is listed.

**Check-in is one statement.** `UPDATE tickets SET status='used', used_at=now(), used_by=$staff WHERE id=$1 AND event_id=$2 AND status='valid' RETURNING ...`. Postgres serialises concurrent updates of one row, so exactly one scan matches and gets `valid`; every other scan matches nothing and is told `used` with the time. There is no read-then-write gap to race in. A bad signature, a token for another show, or an unknown ticket is `invalid` and changes nothing. Responses are 200 `valid`, 409 `used`, 404 `invalid`, as the scanner page expects.

## Trade-offs

- A second scan returns `used`, as specified, so a scanner that retries after a lost response also sees `used` for a ticket it just admitted. The scanner UI should read `used` shortly after a scan as "already admitted". A client-supplied scan id would remove this ambiguity; it is not built because it was not asked for.
- Staff are not tied to an event, so any door-staff token can scan any show's ticket. The scan records who scanned.
- A ticket's QR cannot be revoked yet; voiding on refund arrives in Phase 4 (`status` will gain `void`).
