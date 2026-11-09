// Roblox Top Trending forecaster: model (pure functions; Node 22, standard library only).
//
// Layer 1 (kernel mixture): a recency-weighted mixture of the recent charts; each observed rank r of a game is
// spread over nearby places by a rank-dependent, asymmetric Laplace kernel (wider for lower ranks, wider downward
// for games that have been on the chart for days, because the chart measures a week's relative gain and an old
// surge ages out).
// Layer 2 (incumbent dropout scenarios): the long-time leaders can vanish from the chart outright (DONT SPLASH,
// #1 for a week, left in one read and every game below moved up one place). For each of the top few games a
// scenario "this game drops out" is mixed in with a hazard that grows with the game's time on the chart; the
// forecast of a scenario is layer 1 on a history with that game deleted, so everything below shifts up.
// Layer 3 (calibration): an optional unnamed mass per place (eps0 + eps1 * place); the backtest found the flat
// 3% best, so eps1 is 0. Nothing here reads the network or the clock: the same history gives the same forecast.

export const PLACES = 10;
const HOUR = 3600_000;

export interface Read {
  t: number;
  order: number[];
}
export interface Params {
  tau: number; // recency scale, hours (weight exp(-age/tau))
  s0: number; // kernel width at rank 1
  s1: number; // extra width per rank
  smax: number; // width cap
  up: number; // upward width multiplier
  age: number; // extra downward width scaled by time on chart
  eps0: number; // unnamed mass at place 1
  eps1: number; // extra unnamed mass per place
  q0: number; // base dropout hazard of a top incumbent over the window
  q1: number; // extra hazard for a game that has been on the chart a long time
  qn: number; // how many top places carry a dropout scenario
}
export type Forecast = Array<Map<number, number>>; // index place-1 -> uid -> p

export const DEFAULT: Params = { tau: 4, s0: 0.4, s1: 0.17, smax: 4, up: 0.8, age: 0.5, eps0: 0.03, eps1: 0, q0: 0, q1: 0, qn: 3 };
export const TENURE_FULL_H = 144; // hours on the chart at which the age widening is complete (6 days)
export const HAZARD_FULL_H = 144;
export const RANK_CAP = 40; // ranks of each read that feed the mixture
export const MAX_NAMED = 40; // games named per place
export const LOOKBACK_H = 72;

/** Layer 1 on hist, as the unnormalised-to-1 per-place map. `skip` games are treated as absent from every read. */
function kernelForecast(hist: Read[], p: Params, firstSeen: Map<number, number>, skip: Set<number>): Forecast {
  const t0 = hist[hist.length - 1]!.t;
  const maxAge = Math.min(LOOKBACK_H, p.tau * 8);
  const obs = new Map<number, Array<[number, number]>>(); // uid -> [weight, rank]
  let W = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    const r = hist[i]!;
    const age = (t0 - r.t) / HOUR;
    if (age > maxAge) break;
    const w = Math.exp(-age / p.tau);
    W += w;
    let rank = 0;
    for (let k = 0; k < r.order.length && rank < RANK_CAP; k++) {
      const u = r.order[k]!;
      if (skip.has(u)) continue;
      rank++;
      let a = obs.get(u);
      if (!a) obs.set(u, (a = []));
      a.push([w, rank]);
    }
  }
  const out: Forecast = [];
  for (let place = 1; place <= PLACES; place++) {
    const eps = Math.min(0.6, p.eps0 + p.eps1 * (place - 1));
    const row: Array<[number, number]> = [];
    for (const [u, list] of obs) {
      let v = 0;
      const tenure = Math.min(1, (t0 - (firstSeen.get(u) ?? t0)) / HOUR / TENURE_FULL_H);
      for (const [w, r] of list) {
        const s = Math.min(p.smax, p.s0 + p.s1 * (r - 1));
        const su = s * p.up;
        const sd = s * (1 + p.age * tenure);
        const d = place - r;
        v += (w * Math.exp(-Math.abs(d) / (d < 0 ? su : sd))) / (su + sd);
      }
      if (v > 0) row.push([u, v / W]);
    }
    row.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const top = row.slice(0, MAX_NAMED);
    const tot = top.reduce((s, x) => s + x[1], 0);
    const m = new Map<number, number>();
    if (tot > 0) for (const [u, v] of top) m.set(u, ((1 - eps) * v) / tot);
    out.push(m);
  }
  return out;
}

export function mix(fs: Forecast[], ws: number[]): Forecast {
  const wt = ws.reduce((a, b) => a + b, 0);
  const out: Forecast = [];
  for (let k = 0; k < PLACES; k++) {
    const m = new Map<number, number>();
    fs.forEach((f, i) => {
      for (const [u, v] of f[k]!) m.set(u, (m.get(u) ?? 0) + (v * ws[i]!) / wt);
    });
    const rows = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, MAX_NAMED);
    out.push(new Map(rows));
  }
  return out;
}

export function forecast(hist: Read[], p: Params): Forecast {
  const firstSeen = new Map<number, number>();
  for (const r of hist) {
    const n = Math.min(RANK_CAP, r.order.length);
    for (let k = 0; k < n; k++) if (!firstSeen.has(r.order[k]!)) firstSeen.set(r.order[k]!, r.t);
  }
  const base = kernelForecast(hist, p, firstSeen, new Set());
  if (p.q0 <= 0 && p.q1 <= 0) return base;
  const last = hist[hist.length - 1]!;
  const t0 = last.t;
  const scen: Forecast[] = [base];
  const wts: number[] = [1];
  let rest = 1;
  for (let k = 0; k < Math.min(p.qn, last.order.length); k++) {
    const u = last.order[k]!;
    const ten = Math.min(1, (t0 - (firstSeen.get(u) ?? t0)) / HOUR / HAZARD_FULL_H);
    const q = Math.min(0.5, p.q0 + p.q1 * ten);
    if (q <= 0) continue;
    scen.push(kernelForecast(hist, p, firstSeen, new Set([u])));
    wts.push(q);
    rest -= q;
  }
  wts[0] = Math.max(0.05, rest);
  return mix(scen, wts);
}

// ---------- scoring and run-time tuning ----------
const FLOOR = Math.log(1e-4);

export function scoreRead(f: Forecast, chart: number[]): number {
  let s = 0;
  for (let place = 1; place <= PLACES; place++) {
    const g = chart[place - 1];
    if (g === undefined) continue;
    const rows = f[place - 1]!;
    let pr = rows.get(g);
    if (pr === undefined) {
      let sum = 0;
      for (const v of rows.values()) sum += v;
      let unnamed = 0;
      for (const u of chart) if (!rows.has(u)) unnamed++;
      pr = unnamed > 0 ? Math.max(0, 1 - sum) / unnamed : 0;
    }
    s += pr > 0 ? Math.max(FLOOR, Math.log(pr)) : FLOOR;
  }
  return s;
}

/** Mean log score of params over the given cut-offs, targets up to `horizon` hours after each (the window is a day). */
export function backtest(reads: Read[], p: Params, cutoffs: number[], horizon = 24): number {
  let tot = 0;
  let n = 0;
  for (const i of cutoffs) {
    const t0 = reads[i]!.t;
    const f = forecast(reads.slice(0, i + 1), p);
    let s = 0;
    let m = 0;
    for (let j = i + 1; j < reads.length; j++) {
      const dt = (reads[j]!.t - t0) / HOUR;
      if (dt > horizon) break;
      s += scoreRead(f, reads[j]!.order);
      m++;
    }
    if (m > 0) {
      tot += s / m;
      n++;
    }
  }
  return n > 0 ? tot / n : -Infinity;
}

export function chooseCutoffs(reads: Read[], minHistH = 24, minAheadH = 12, spacingH = 2): number[] {
  const first = reads[0]!.t;
  const last = reads[reads.length - 1]!.t;
  const idx: number[] = [];
  let lastPicked = -Infinity;
  for (let i = 0; i < reads.length; i++) {
    const t = reads[i]!.t;
    if (t - first < minHistH * HOUR) continue;
    if (last - t < minAheadH * HOUR) continue;
    if (t - lastPicked < spacingH * HOUR - 1) continue;
    idx.push(i);
    lastPicked = t;
  }
  return idx;
}

export function grid(): Params[] {
  const out: Params[] = [];
  for (const tau of [2, 4, 8, 16])
    for (const s0 of [0.3, 0.5])
      for (const s1 of [0.1, 0.17, 0.25])
        for (const up of [0.7, 0.9])
          for (const q1 of [0, 0.1])
            for (const age of [0, 0.5]) out.push({ ...DEFAULT, tau, s0, s1, up, q1, age });
  return out;
}

/** Ensemble: the prior defaults plus the best few grid points on the history's own cut-offs. */
export function tunedForecast(reads: Read[], defaults: Params = DEFAULT, top = 3): { f: Forecast; info: string } {
  const cuts = chooseCutoffs(reads);
  if (cuts.length < 6) return { f: forecast(reads, defaults), info: `cutoffs ${cuts.length}: defaults` };
  const scored = grid()
    .map((p) => ({ p, s: backtest(reads, p, cuts) }))
    .sort((a, b) => b.s - a.s || a.p.tau - b.p.tau);
  const best = scored.slice(0, top);
  const members = [defaults, ...best.map((b) => b.p)];
  return {
    f: mix(members.map((p) => forecast(reads, p)), members.map(() => 1)),
    info: `cutoffs ${cuts.length}; best ${best.map((b) => b.s.toFixed(2)).join(' ')}`,
  };
}
