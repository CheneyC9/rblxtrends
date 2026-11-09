// Walk-forward backtest of a forecaster module over data/all.json.
// usage: node bt.mjs [model.ts] ; the module exports forecast(hist, params) and DEFAULT (and optionally variants).
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export const HOUR = 3600e3;
const FLOOR = Math.log(1e-4);

export function loadAll(path = 'data/all.json') {
  return JSON.parse(readFileSync(path, 'utf8')).map((r) => ({ t: r.t, order: r.order }));
}

/** the contest's order score of forecast f (array of Map uid->p, place 1 first) on one chart */
export function scoreChart(f, chart, perPlace) {
  let s = 0;
  for (let k = 0; k < 10; k++) {
    const g = chart[k];
    const rows = f[k];
    let p = rows.get(g);
    if (p === undefined) {
      let sum = 0;
      for (const v of rows.values()) sum += v;
      let unnamed = 0;
      for (const u of chart) if (!rows.has(u)) unnamed++;
      p = unnamed > 0 ? Math.max(0, 1 - sum) / unnamed : 0;
    }
    const l = Math.max(FLOOR, Math.log(Math.max(p, 1e-300)));
    if (perPlace) perPlace[k] += l;
    s += l;
  }
  return s;
}

/** persistence house baseline as in the kit's starter */
export function persistence(hist) {
  const chart = hist[hist.length - 1].order;
  const f = [];
  for (let k = 0; k < 10; k++) {
    const m = new Map();
    m.set(chart[k], 0.5);
    if (k === 0) m.set(chart[1], 0.3);
    else {
      m.set(chart[k - 1], 0.15);
      if (chart[k + 1] !== undefined) m.set(chart[k + 1], 0.15);
    }
    f.push(m);
  }
  return f;
}

/** cutoffs: reads with >= minHist hours behind and at least minTargets reads in the next 24 h */
export function cutoffs(reads, { minHist = 24, minTargets = 2, horizon = 24 } = {}) {
  const out = [];
  for (let i = 0; i < reads.length; i++) {
    if (reads[i].t - reads[0].t < minHist * HOUR) continue;
    let n = 0;
    for (let j = i + 1; j < reads.length && reads[j].t - reads[i].t <= horizon * HOUR; j++) n++;
    if (n >= minTargets) out.push(i);
  }
  return out;
}

export function evaluate(reads, fn, cuts, { horizon = 24, detail = false } = {}) {
  const per = new Array(10).fill(0);
  let nT = 0;
  const wins = [];
  for (const i of cuts) {
    const f = fn(reads.slice(0, i + 1));
    let s = 0, m = 0;
    for (let j = i + 1; j < reads.length && reads[j].t - reads[i].t <= horizon * HOUR; j++) {
      s += scoreChart(f, reads[j].order, per);
      m++;
    }
    nT += m;
    wins.push(s / m);
  }
  const mean = wins.reduce((a, b) => a + b, 0) / wins.length;
  const sd = Math.sqrt(wins.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, wins.length - 1));
  return { mean, se: sd / Math.sqrt(wins.length), n: wins.length, perPlace: per.map((v) => v / nT), wins };
}

if (process.argv[1] && process.argv[1].endsWith('bt.mjs')) {
  const reads = loadAll();
  const cuts = cutoffs(reads);
  console.log('reads', reads.length, 'cutoffs', cuts.length);
  const b = evaluate(reads, persistence, cuts);
  console.log('persistence', b.mean.toFixed(2), '+-', b.se.toFixed(2), b.perPlace.map((x) => x.toFixed(1)).join(' '));
  if (process.argv[2]) {
    const mod = await import(pathToFileURL(resolve(process.argv[2])).href);
    const r = evaluate(reads, (h) => mod.forecast(h, mod.DEFAULT), cuts);
    console.log('model DEFAULT', r.mean.toFixed(2), '+-', r.se.toFixed(2), r.perPlace.map((x) => x.toFixed(1)).join(' '));
    console.log('windows', r.wins.map((x) => x.toFixed(1)).join(' '));
  }
}
