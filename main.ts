// SPDX-License-Identifier: MIT
// Roblox Top Trending forecaster (Node 22, standard library only).
//
// Reads /input/history.ndjson (every read of the chart, oldest first) and /input/task.json, writes
// /output/forecast.json: for each of the top 10 places, a probability for each game, plus a top-10 guess.
//
// Model: a recency-weighted mixture of the recent charts, where each observed rank r of a game is spread
// over nearby places by a rank-dependent, asymmetric Laplace kernel. Analysis of the Oct 30 - Nov 8 chart
// archive showed:
//   - the top places are sticky (#1 stays #1 ~82% over 1-25 h) while #8-#12 hold their place only ~20%,
//     so the kernel width grows with rank;
//   - downward moves are a little wider than upward ones (games drift down, then the chart reshuffles);
//   - about 7% of top-4 games drop off the chart entirely within a day, so some mass stays unnamed;
//   - games that have sat on the chart for ~4-6 days fall 3+ places about 22% of the time vs 8% for games in
//     their first 2 days (the chart measures a week's gain, so an old surge ages out), so their downward
//     width grows with time on the chart;
//   - player-count momentum and rank momentum add nothing measurable once spread is calibrated.
// The kernel's parameters are re-fitted at run time on the given history itself: every read is used as a
// cut-off, the reads 1-25 h after it are scored with the contest's own log score, and the best few
// parameter sets are averaged with the prior defaults (an ensemble, which is safe under a log score).
//
// Outside the grader: mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const FLOOR = Math.log(1e-4);
const HOUR = 3600_000;

interface Read {
  t: number;
  order: number[];
}
interface Params {
  tau: number; // recency half-life-ish, hours (weight exp(-age/tau))
  s0: number; // kernel width at rank 1
  s1: number; // extra width per rank
  smax: number; // width cap
  up: number; // upward width multiplier (< 1: upward moves narrower)
  eps: number; // mass left unnamed at each place
  age: number; // extra downward width, scaled by time on the chart (a week-old surge is ageing out)
}
type Forecast = Array<Map<number, number>>; // index place-1 -> uid -> p

// Prior defaults, the best region of the Oct 30 - Nov 8 walk-forward backtest (about -18.5 vs the
// persistence baseline's -22.2 over 21 daily windows).
const DEFAULT: Params = { tau: 4, s0: 0.4, s1: 0.17, smax: 4, up: 0.8, eps: 0.03, age: 0.5 };
const TENURE_FULL_H = 144; // hours on the chart at which the age widening is complete (6 days)
const RANK_CAP = 40; // ranks of each read that feed the mixture
const MAX_NAMED = 40; // games named per place
const LOOKBACK_H = 72;

// ---------- input ----------
const task = JSON.parse(readFileSync(join(INPUT_DIR, 'task.json'), 'utf8')) as {
  places: number;
  output: string;
  history_until?: string;
  window?: { from: string; until: string };
};
const PLACES: number = task.places ?? 10;

function loadHistory(): Read[] {
  const lines = readFileSync(join(INPUT_DIR, 'history.ndjson'), 'utf8').split('\n');
  const reads: Read[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d?.ok === false || !Array.isArray(d?.top_trending) || d.top_trending.length === 0) continue;
    const t = Date.parse(d.at);
    if (!Number.isFinite(t)) continue;
    const rows = [...d.top_trending]
      .filter((g: any) => Number.isFinite(Number(g?.universe_id)))
      .sort((a: any, b: any) => (a.rank ?? 0) - (b.rank ?? 0));
    const seen = new Set<number>();
    const order: number[] = [];
    for (const g of rows) {
      const u = Number(g.universe_id);
      if (!seen.has(u)) {
        seen.add(u);
        order.push(u);
      }
    }
    reads.push({ t, order });
  }
  reads.sort((a, b) => a.t - b.t);
  return reads;
}

// ---------- model ----------
function forecast(hist: Read[], p: Params): Forecast {
  const t0 = hist[hist.length - 1]!.t;
  const maxAge = Math.min(LOOKBACK_H, p.tau * 8);
  // when each game first showed in the chart's top RANK_CAP (the history starts Oct 30, so older games are
  // treated as on the chart since then)
  const firstSeen = new Map<number, number>();
  for (const r of hist) {
    const n = Math.min(RANK_CAP, r.order.length);
    for (let k = 0; k < n; k++) if (!firstSeen.has(r.order[k]!)) firstSeen.set(r.order[k]!, r.t);
  }
  const obs = new Map<number, Array<[number, number]>>(); // uid -> [weight, rank]
  let W = 0;
  for (let i = hist.length - 1; i >= 0; i--) {
    const r = hist[i]!;
    const age = (t0 - r.t) / HOUR;
    if (age > maxAge) break;
    const w = Math.exp(-age / p.tau);
    W += w;
    const n = Math.min(RANK_CAP, r.order.length);
    for (let k = 0; k < n; k++) {
      const u = r.order[k]!;
      let a = obs.get(u);
      if (!a) obs.set(u, (a = []));
      a.push([w, k + 1]);
    }
  }
  const out: Forecast = [];
  for (let place = 1; place <= PLACES; place++) {
    const row: Array<[number, number]> = [];
    for (const [u, list] of obs) {
      let v = 0;
      const tenure = Math.min(1, (t0 - (firstSeen.get(u) ?? t0)) / HOUR / TENURE_FULL_H);
      for (const [w, r] of list) {
        const s = Math.min(p.smax, p.s0 + p.s1 * (r - 1)); // downward width before ageing
        const su = s * p.up; // upward width
        const sd = s * (1 + p.age * tenure); // downward width, wider for games late in their week
        const d = place - r;
        v += (w * Math.exp(-Math.abs(d) / (d < 0 ? su : sd))) / (su + sd);
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

function scoreRead(f: Forecast, chart: number[]): number {
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

/** Mean backtest log score of params over every cut-off with targets 1-25 h ahead. */
function backtest(reads: Read[], p: Params, cutoffs: number[]): number {
  let tot = 0;
  let n = 0;
  for (const i of cutoffs) {
    const t0 = reads[i]!.t;
    const f = forecast(reads.slice(0, i + 1), p);
    let s = 0;
    let m = 0;
    for (let j = i + 1; j < reads.length; j++) {
      const dt = (reads[j]!.t - t0) / HOUR;
      if (dt <= 1) continue;
      if (dt > 25) break;
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

function chooseCutoffs(reads: Read[]): number[] {
  const first = reads[0]!.t;
  const last = reads[reads.length - 1]!.t;
  const idx: number[] = [];
  let lastPicked = -Infinity;
  for (let i = 0; i < reads.length; i++) {
    const t = reads[i]!.t;
    if (t - first < 24 * HOUR) continue; // needs some history behind it
    if (last - t < 12 * HOUR) continue; // needs at least half a day of targets ahead
    if (t - lastPicked < 2 * HOUR - 1) continue; // thin hourly stretches to every 2 h
    idx.push(i);
    lastPicked = t;
  }
  return idx;
}

/** 384 coarse parameter sets; tau up to 16 h lets an hourly history average over the day's cycle. */
function grid(): Params[] {
  const out: Params[] = [];
  for (const tau of [2, 4, 8, 16])
    for (const s0 of [0.3, 0.5])
      for (const s1 of [0.1, 0.17, 0.25])
        for (const up of [0.7, 0.9])
          for (const eps of [0.02, 0.04])
            for (const age of [0, 0.5]) out.push({ tau, s0, s1, smax: 4, up, eps, age });
  return out;
}

function mix(fs: Forecast[], ws: number[]): Forecast {
  const wt = ws.reduce((a, b) => a + b, 0);
  const out: Forecast = [];
  for (let k = 0; k < PLACES; k++) {
    const m = new Map<number, number>();
    fs.forEach((f, i) => {
      for (const [u, v] of f[k]!) m.set(u, (m.get(u) ?? 0) + (v * ws[i]!) / wt);
    });
    // keep the strongest MAX_NAMED rows; the rest falls back into the unnamed share
    const rows = [...m.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, MAX_NAMED);
    out.push(new Map(rows));
  }
  return out;
}

// ---------- main ----------
const reads = loadHistory();
if (reads.length === 0) throw new Error('empty history');

let final: Forecast;
const cutoffs = chooseCutoffs(reads);
if (cutoffs.length >= 6) {
  const scored = grid()
    .map((p) => ({ p, s: backtest(reads, p, cutoffs) }))
    .sort((a, b) => b.s - a.s || a.p.tau - b.p.tau);
  const defScore = backtest(reads, DEFAULT, cutoffs);
  const best = scored.slice(0, 3);
  process.stderr.write(
    `cutoffs ${cutoffs.length}; default ${defScore.toFixed(3)}; best ${best
      .map((b) => `${b.s.toFixed(3)} ${JSON.stringify(b.p)}`)
      .join(' | ')}\n`,
  );
  const members = [DEFAULT, ...best.map((b) => b.p)];
  final = mix(
    members.map((p) => forecast(reads, p)),
    [1, 1, 1, 1],
  );
} else {
  final = forecast(reads, DEFAULT);
}

// rows, rounded down so no place sums past 1
const probabilities: Array<{ universe_id: number; place: number; p: number }> = [];
for (let k = 0; k < PLACES; k++) {
  for (const [u, v] of final[k]!) {
    const p = Math.floor(v * 1e6) / 1e6;
    if (p > 0) probabilities.push({ universe_id: u, place: k + 1, p });
  }
}

// top 10: greedily take the most confident (place, game) pair still free
const pairs: Array<[number, number, number]> = [];
for (let k = 0; k < PLACES; k++) for (const [u, v] of final[k]!) pairs.push([v, k, u]);
pairs.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
const slot: Array<number | undefined> = new Array(PLACES).fill(undefined);
const used = new Set<number>();
for (const [, k, u] of pairs) {
  if (slot[k] !== undefined || used.has(u)) continue;
  slot[k] = u;
  used.add(u);
}
const fallback = reads[reads.length - 1]!.order.filter((u) => !used.has(u));
const top10 = slot.map((u) => (u !== undefined ? u : fallback.shift()!)).filter((u) => u !== undefined);

writeFileSync(join(OUTPUT_DIR, task.output ?? 'forecast.json'), `${JSON.stringify({ probabilities, top10 })}\n`);
