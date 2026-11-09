// Deterministic, standalone forecaster. No I/O, dependencies, or game-specific IDs.
// The supplied rank kernel is retained; one strength parameter controls three
// linked changes: common-game momentum, stability sharpening, and dropout hedging.
export interface Read { t: number; order: number[] }
export interface Params { strength: number }
export type Forecast = Map<number, number>[];
export const DEFAULT: Params = { strength: 1 };

const HOUR = 3_600_000;
const RANK_CAP = 40;
const PLACES = 10;
const TREND_HOURS = 24;
const TAU = 4;
const EPS = 0.03;

interface Stats { drift: number; stable: number }

// Delete scenario dropouts before comparing ranks. Count only common games so
// insertions and removals cannot masquerade as momentum for every survivor.
function statistics(hist: Read[], skip: Set<number>): Map<number, Stats> {
  const last = hist[hist.length - 1]!;
  const current = last.order.filter(u => !skip.has(u)).slice(0, RANK_CAP);
  const out = new Map<number, Stats>();
  const previous: { age: number; order: number[] }[] = [];
  for (let i = hist.length - 2; i >= 0; i--) {
    const age = (last.t - hist[i]!.t) / HOUR;
    if (age > TREND_HOURS * 3) break;
    // Near-duplicate reads should not create huge estimated velocities.
    if (age >= 1) previous.push({ age, order: hist[i]!.order.filter(u => !skip.has(u)) });
  }
  for (let k = 0; k < current.length; k++) {
    const u = current[k]!;
    let sw = 0, drift = 0, unchanged = 0;
    for (const { age, order } of previous) {
      const r = order.indexOf(u);
      if (r < 0) continue;
      const w = Math.exp(-age / TREND_HOURS);
      const common = new Set(current.filter(v => order.includes(v)));
      const a = current.slice(0, k).filter(v => common.has(v)).length;
      const b = order.slice(0, r).filter(v => common.has(v)).length;
      const delta = a - b;
      drift += w * Math.max(-4, Math.min(4, delta * 12 / Math.max(6, age)));
      unchanged += w * (delta === 0 ? 1 : 0);
      sw += w;
    }
    out.set(u, { drift: sw ? drift / sw : 0, stable: sw ? unchanged / sw : 0 });
  }
  return out;
}

function kernel(hist: Read[], strength: number, firstSeen: Map<number, number>, skip: Set<number>): Forecast {
  const t0 = hist[hist.length - 1]!.t;
  const stats = statistics(hist, skip);
  const obs = new Map<number, [number, number][]>();
  let totalWeight = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    const read = hist[i]!;
    const age = (t0 - read.t) / HOUR;
    if (age > 32) break;
    const w = Math.exp(-age / TAU);
    totalWeight += w;
    let rank = 0;
    for (const u of read.order) {
      if (skip.has(u)) continue;
      rank++;
      let list = obs.get(u);
      if (!list) obs.set(u, (list = []));
      list.push([w, rank]);
      if (rank >= RANK_CAP) break;
    }
  }
  const out: Forecast = [];
  for (let place = 1; place <= PLACES; place++) {
    const row: [number, number][] = [];
    for (const [u, list] of obs) {
      const st = stats.get(u) ?? { drift: 0, stable: 0 };
      const tenure = Math.min(1, (t0 - (firstSeen.get(u) ?? t0)) / HOUR / 144);
      let value = 0;
      for (const [w, rank] of list) {
        const width = Math.min(4, (0.4 + 0.17 * (rank - 1)) * Math.max(0.3, 1 - 0.3 * strength * st.stable));
        const up = width * 0.8;
        const down = width * (1 + 0.5 * tenure);
        const center = Math.max(1, rank + 0.25 * strength * st.drift);
        const d = place - center;
        value += w * Math.exp(-Math.abs(d) / (d < 0 ? up : down)) / (up + down);
      }
      if (value > 0) row.push([u, value / totalWeight]);
    }
    row.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const top = row.slice(0, RANK_CAP);
    const sum = top.reduce((s, [, value]) => s + value, 0);
    out.push(new Map(top.map(([u, value]) => [u, (1 - EPS) * value / sum])));
  }
  return out;
}

function mix(forecasts: Forecast[], weights: number[]): Forecast {
  const total = weights.reduce((a, b) => a + b, 0);
  return Array.from({ length: PLACES }, (_, k) => {
    const row = new Map<number, number>();
    forecasts.forEach((f, i) => {
      for (const [u, value] of f[k]!) row.set(u, (row.get(u) ?? 0) + value * weights[i]! / total);
    });
    // Truncation leaves the discarded probability in the unnamed pool.
    return new Map([...row].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, RANK_CAP));
  });
}

// History must be chronological, as in bt.mjs. Only its t and order fields are used.
export function forecast(hist: Read[], params: Partial<Params> = {}): Forecast {
  if (!hist.length) return Array.from({ length: PLACES }, () => new Map());
  const requested = params.strength ?? DEFAULT.strength;
  const strength = Number.isFinite(requested) ? Math.max(0, Math.min(1.5, requested)) : DEFAULT.strength;
  const firstSeen = new Map<number, number>();
  for (const read of hist) {
    for (const u of read.order.slice(0, RANK_CAP)) {
      if (!firstSeen.has(u)) firstSeen.set(u, read.t);
    }
  }
  const forecasts = [kernel(hist, strength, firstSeen, new Set())];
  if (strength === 0) return forecasts[0]!;
  const last = hist[hist.length - 1]!;
  const weights = [1];
  let rest = 1;
  // Single-dropout scenarios preserve the joint shift of everyone below a leader.
  // A small hedge compensates for sharpening stable incumbents. First-seen age
  // is left-censored; it is a soft hedge, not an estimated expiration date.
  for (const u of last.order.slice(0, 3)) {
    const tenure = Math.min(1, (last.t - (firstSeen.get(u) ?? last.t)) / HOUR / 144);
    const q = 0.1 * strength * tenure;
    if (q <= 0) continue;
    forecasts.push(kernel(hist, strength, firstSeen, new Set([u])));
    weights.push(q);
    rest -= q;
  }
  weights[0] = Math.max(0.05, rest);
  return mix(forecasts, weights);
}
