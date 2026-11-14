/**
 * The hold countdown follows the SERVER's clock, never the browser's alone. A phone whose clock is
 * five minutes off must still see the true time left.
 */

/** Server clock minus this browser's clock, measured when the booking was fetched. */
export const clockSkew = (serverTimeIso: string, clientNowMs: number): number =>
  Date.parse(serverTimeIso) - clientNowMs;

/** Whole seconds left on the hold at browser time `nowMs`, given the measured skew. Never negative. */
export function secondsLeft(holdExpiresAtIso: string, nowMs: number, skewMs: number): number {
  return Math.max(0, Math.floor((Date.parse(holdExpiresAtIso) - (nowMs + skewMs)) / 1000));
}
