// Two more forecaster families for the ensemble (pure functions; Node 22, standard library only).
//
// markov: an empirical-Bayes transition model. Every pair of reads (i, j) at most 24 h apart in the history is a
// training example: "a game that was in state s at read i was at place k at read j". The state is the game's rank
// bucket crossed with its trend over the previous 12-24 h (new / rising / flat / falling). The counts are shrunk
// toward the parametric rank kernel of model.ts, so a thin history falls back to the kernel and a long one lets the
// chart's own dynamics speak. Recent pairs weigh more.
//
// seasonal: a daily-cycle model. The 24 h after the cut-off are scored hour by hour, and the chart at hour h of that
// day is the best single guess for the chart the day before at the same hour, so the forecast is the time-weighted
// occupancy of the last 24 h (plus a smaller share of the 24 h before that), lightly smoothed over places.

import { PLACES, RANK_CAP, MAX_NAMED } from '../model.ts';
import type { Read, Forecast } from '../model.ts';

const HOUR = 3600_000;

export interface MarkovParams {
  n0: number; // prior strength (pseudo-examples per state)
  tauPairH: number; // recency scale of training pairs, hours
  eps: number; // unnamed mass per place
  s0: number;
  s1: number;
  smax: number;
  up: number;
}
export const MARKOV_DEFAULT: MarkovParams = { n0: 8, tauPairH: 120, eps: 0.03, s0: 0.4, s1: 0.17, smax: 4, up: 0.8 };

const BUCKETS = [1, 2, 3, 5, 8, 12, 20, 40]; // upper rank of each bucket
const bucket = (r: number): number => {
  for (let b = 0; b < BUCKETS.length; b++) if (r <= BUCKETS[b]!) return b;
  return BUCKETS.length - 1;
};
const NT = 4; // new, rising, flat, falling

/** Trend class of every game in read i, compared with the read nearest to 18 h earlier (>= 10 h). */
function trendAt(reads: Read[], i: number, rankMaps: Array<Map<number, number>>): Map<number, number> {
  const t = reads[i]!.t;
  let ref = -1;
  for (let j = i - 1; j >= 0; j--) {
    const age = (t - reads[j]!.t) / HOUR;
    if (age >= 10) {
      ref = j;
      if (age >= 18) break;
    }
  }
  const out = new Map<number, number>();
  const cur = rankMaps[i]!;
  for (const [u, r] of cur) {
    if (ref < 0) {
      out.set(u, 2);
      continue;
    }
    const before = rankMaps[ref]!.get(u);
    if (before === undefined) out.set(u, 0);
    else if (before - r >= 2) out.set(u, 1);
    else if (r - before >= 2) out.set(u, 3);
    else out.set(u, 2);
  }
  return out;
}

function kernelRow(r: number, p: MarkovParams): number[] {
  const s = Math.min(p.smax, p.s0 + p.s1 * (r - 1));
  const su = s * p.up;
  const sd = s;
  const raw: number[] = [];
  let tot = 0;
  for (let k = 1; k <= 60; k++) {
    const d = k - r;
    const v = Math.exp(-Math.abs(d) / (d < 0 ? su : sd)) / (su + sd);
    if (k <= PLACES) raw.push(v);
    tot += v;
  }
  return raw.map((v) => v / tot);
}

export function markovForecast(hist: Read[], p: MarkovParams = MARKOV_DEFAULT): Forecast {
  const n = hist.length;
  const rankMaps = hist.map((r) => new Map(r.order.slice(0, RANK_CAP).map((u, i) => [u, i + 1] as [number, number])));
  const NS = BUCKETS.length * NT;
  const C: number[][] = Array.from({ length: NS }, () => new Array(PLACES).fill(0));
  const N: number[] = new Array(NS).fill(0);
  const t0 = hist[n - 1]!.t;
  for (let i = 0; i < n - 1; i++) {
    const tr = trendAt(hist, i, rankMaps);
    const src = rankMaps[i]!;
    for (let j = i + 1; j < n; j++) {
      const dt = (hist[j]!.t - hist[i]!.t) / HOUR;
      if (dt > 24) break;
      const w = Math.exp(-((t0 - hist[j]!.t) / HOUR) / p.tauPairH);
      for (const [u, r] of src) N[bucket(r) * NT + tr.get(u)!] += w;
      const tgt = hist[j]!.order;
      for (let k = 0; k < Math.min(PLACES, tgt.length); k++) {
        const r = src.get(tgt[k]!);
        if (r !== undefined) C[bucket(r) * NT + tr.get(tgt[k]!)!]![k]! += w;
      }
    }
  }
  // prior row of a bucket: mean kernel row over its ranks
  const prior: number[][] = [];
  for (let b = 0; b < BUCKETS.length; b++) {
    const lo = b === 0 ? 1 : BUCKETS[b - 1]! + 1;
    const row = new Array(PLACES).fill(0);
    for (let r = lo; r <= BUCKETS[b]!; r++) kernelRow(r, p).forEach((v, k) => (row[k] += v / (BUCKETS[b]! - lo + 1)));
    prior.push(row);
  }
  const last = n - 1;
  const trLast = trendAt(hist, last, rankMaps);
  const out: Forecast = [];
  for (let k = 0; k < PLACES; k++) {
    const rows: Array<[number, number]> = [];
    for (const [u, r] of rankMaps[last]!) {
      const b = bucket(r);
      const s = b * NT + trLast.get(u)!;
      // the bucket's prior is blurred, so sharpen it with the game's own rank: use that rank's kernel row
      const pr = kernelRow(r, p)[k]!;
      const v = (C[s]![k]! + p.n0 * pr) / (N[s]! + p.n0);
      rows.push([u, v]);
    }
    rows.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const top = rows.slice(0, MAX_NAMED);
    const tot = top.reduce((s, x) => s + x[1], 0);
    const m = new Map<number, number>();
    if (tot > 0) for (const [u, v] of top) m.set(u, ((1 - p.eps) * v) / tot);
    out.push(m);
  }
  void prior;
  return out;
}

export interface SeasonalParams {
  w2: number; // share of the 24-48 h-ago window
  eps: number;
  s0: number;
  s1: number;
  smax: number;
}
export const SEASONAL_DEFAULT: SeasonalParams = { w2: 0.35, eps: 0.03, s0: 0.35, s1: 0.12, smax: 3 };

export function seasonalForecast(hist: Read[], p: SeasonalParams = SEASONAL_DEFAULT): Forecast {
  const n = hist.length;
  const t0 = hist[n - 1]!.t;
  const obs = new Map<number, Array<[number, number]>>();
  let W = 0;
  // each read stands for the stretch of time halfway to its neighbours (capped at 6 h)
  for (let i = n - 1; i >= 0; i--) {
    const age = (t0 - hist[i]!.t) / HOUR;
    if (age > 48) break;
    const prev = i > 0 ? (hist[i]!.t - hist[i - 1]!.t) / HOUR : 6;
    const next = i < n - 1 ? (hist[i + 1]!.t - hist[i]!.t) / HOUR : 0;
    const span = Math.min(6, prev) / 2 + Math.min(6, next) / 2 + (i === n - 1 ? 0.25 : 0);
    const w = span * (age <= 24 ? 1 : p.w2);
    if (w <= 0) continue;
    W += w;
    const order = hist[i]!.order;
    for (let k = 0; k < Math.min(RANK_CAP, order.length); k++) {
      let a = obs.get(order[k]!);
      if (!a) obs.set(order[k]!, (a = []));
      a.push([w, k + 1]);
    }
  }
  const out: Forecast = [];
  for (let place = 1; place <= PLACES; place++) {
    const row: Array<[number, number]> = [];
    for (const [u, list] of obs) {
      let v = 0;
      for (const [w, r] of list) {
        const s = Math.min(p.smax, p.s0 + p.s1 * (r - 1));
        v += (w * Math.exp(-Math.abs(place - r) / s)) / (2 * s);
      }
      if (v > 0) row.push([u, v / W]);
    }
    row.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    const top = row.slice(0, MAX_NAMED);
    const tot = top.reduce((s, x) => s + x[1], 0);
    const m = new Map<number, number>();
    if (tot > 0) for (const [u, v] of top) m.set(u, ((1 - p.eps) * v) / tot);
    out.push(m);
  }
  return out;
}
