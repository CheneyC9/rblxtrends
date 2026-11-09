// SPDX-License-Identifier: MIT
// Roblox Top Trending forecaster (Node 22, standard library only).
//
// Reads /input/history.ndjson (every read of the chart, oldest first) and /input/task.json, writes
// /output/forecast.json: for each of the top 10 places, a probability for each game, plus a top-10 guess.
// The model is in model.ts: a recency-weighted rank-kernel mixture plus "incumbent drops out" scenarios
// (see the header there and STRATEGY.md for the evidence behind each choice).
//
// Outside the grader: mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT, forecast } from './model.ts';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Production parameters: the model defaults plus a hedge on the two top games leaving the chart. The hazard
// grows with a game's time on the chart (walk-forward backtest, Oct 30 - Nov 9: -18.9 -> -18.65 overall and
// +0.65 on the later half, a few nats better on the windows where a long-time #1 vanished).
const PARAMS = { ...DEFAULT, qn: 2, q1: 0.1 };

const task = JSON.parse(readFileSync(join(INPUT_DIR, 'task.json'), 'utf8')) as {
  places: number;
  output: string;
};
const PLACES: number = task.places ?? 10;

interface Read {
  t: number;
  order: number[];
}

function loadHistory(): Read[] {
  const reads: Read[] = [];
  for (const line of readFileSync(join(INPUT_DIR, 'history.ndjson'), 'utf8').split('\n')) {
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

const reads = loadHistory();
if (reads.length === 0) throw new Error('empty history');
const final = forecast(reads, PARAMS);

// rows, rounded down so no place sums past 1
const probabilities: Array<{ universe_id: number; place: number; p: number }> = [];
for (let k = 0; k < PLACES; k++) {
  for (const [u, v] of final[k] ?? []) {
    const p = Math.floor(v * 1e6) / 1e6;
    if (p > 0) probabilities.push({ universe_id: u, place: k + 1, p });
  }
}

// top 10: greedily take the most confident (place, game) pair still free
const pairs: Array<[number, number, number]> = [];
for (let k = 0; k < PLACES; k++) for (const [u, v] of final[k] ?? []) pairs.push([v, k, u]);
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
