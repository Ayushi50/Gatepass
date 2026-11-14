export interface RowSpec {
  label: string; // "A"
  tier: string; // "Front"
  priceMinor: number;
}

export interface SeatSpec {
  seatId: string;
  row: string;
  number: number;
  tier: string;
  priceMinor: number;
}

export interface TierSummary {
  name: string;
  priceMinor: number;
  seatCount: number;
}

/** Rows x seatsPerRow, ids like "C6". */
export function buildSeatMap(rows: RowSpec[], seatsPerRow: number): SeatSpec[] {
  const seats: SeatSpec[] = [];
  const labels = new Set<string>();
  for (const r of rows) {
    if (labels.has(r.label)) throw new Error(`duplicate row label ${r.label}`);
    labels.add(r.label);
    for (let n = 1; n <= seatsPerRow; n++) {
      seats.push({
        seatId: `${r.label}${n}`,
        row: r.label,
        number: n,
        tier: r.tier,
        priceMinor: r.priceMinor,
      });
    }
  }
  return seats;
}

/** One entry per tier, in first-seen order. A tier must have a single price. */
export function summarizeTiers(seats: SeatSpec[]): TierSummary[] {
  const tiers = new Map<string, TierSummary>();
  for (const s of seats) {
    const t = tiers.get(s.tier);
    if (!t) {
      tiers.set(s.tier, { name: s.tier, priceMinor: s.priceMinor, seatCount: 1 });
    } else {
      if (t.priceMinor !== s.priceMinor) throw new Error(`tier ${s.tier} has two prices`);
      t.seatCount++;
    }
  }
  return [...tiers.values()];
}
