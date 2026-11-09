// Run from the folder that holds data/all.json (see build-dataset.mjs): node research/stack.mjs
// Walk-forward stacking of forecaster families: cache each family's forecast per cut-off, then score weighted mixtures.
import { loadAll, cutoffs, scoreChart, HOUR } from './bt.mjs';
const imp = (p) => import(new URL(p, import.meta.url).href);
const model = await imp('../model.ts');
const alt = await imp('../alt.ts');
const fam = await imp('./families.ts');

const reads = loadAll();
const cuts = cutoffs(reads);
const KP = { ...model.DEFAULT, qn: 2, q1: 0.1 };
const FAMS = {
  K: (h) => model.forecast(h, KP),
  A: (h) => alt.forecast(h, alt.DEFAULT),
  M: (h) => fam.markovForecast(h),
  S: (h) => fam.seasonalForecast(h),
};
const names = Object.keys(FAMS);
const cache = {}; // name -> [forecast per cut]
for (const n of names) cache[n] = cuts.map((i) => FAMS[n](reads.slice(0, i + 1)));

function winScore(f, ci) {
  const i = cuts[ci];
  let s = 0, m = 0;
  for (let j = i + 1; j < reads.length && reads[j].t - reads[i].t <= 24 * HOUR; j++) { s += scoreChart(f, reads[j].order); m++; }
  return s / m;
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const per = {};
for (const n of names) per[n] = cuts.map((_, ci) => winScore(cache[n][ci], ci));
console.log('cutoffs', cuts.length);
for (const n of names) console.log(n, mean(per[n]).toFixed(3));

function mixed(w, ci) {
  const fs = names.map((n) => cache[n][ci]);
  return model.mix(fs, w);
}
function evalW(w, idx) { return mean(idx.map((ci) => winScore(mixed(w, ci), ci))); }

const all = cuts.map((_, i) => i);
const half1 = all.filter((i) => i < all.length / 2);
const half2 = all.filter((i) => i >= all.length / 2);
const grid = [];
const step = 0.1;
(function rec(k, left, cur) {
  if (k === names.length - 1) { grid.push([...cur, left]); return; }
  for (let v = 0; v <= left + 1e-9; v += step) rec(k + 1, +(left - v).toFixed(10), [...cur, +v.toFixed(10)]);
})(0, 1, []);
const res = grid.filter((w) => w.some((x) => x > 0)).map((w) => ({ w, s: evalW(w, all), a: evalW(w, half1), b: evalW(w, half2) }));
res.sort((x, y) => y.s - x.s);
console.log('weights order', names.join(''));
for (const r of res.slice(0, 8)) console.log(r.w.join(' '), r.s.toFixed(3), 'h1', r.a.toFixed(3), 'h2', r.b.toFixed(3));
const cur = res.find((r) => r.w[0] === 0.5 && r.w[1] === 0.5 && r.w[2] === 0 && r.w[3] === 0);
console.log('current 50/50 K,A', cur.s.toFixed(3), 'h1', cur.a.toFixed(3), 'h2', cur.b.toFixed(3));
// transfer: best of half1 evaluated on half2 and vice versa
const b1 = [...res].sort((x, y) => y.a - x.a)[0];
const b2 = [...res].sort((x, y) => y.b - x.b)[0];
console.log('best on h1', b1.w.join(' '), '-> h2', b1.b.toFixed(3), '(cur h2', cur.b.toFixed(3) + ')');
console.log('best on h2', b2.w.join(' '), '-> h1', b2.a.toFixed(3), '(cur h1', cur.a.toFixed(3) + ')');
const eq = res.find((r) => r.w.every((x) => Math.abs(x - 0.25) < 1e-6));
if (eq) console.log('equal 4-way', eq.s.toFixed(3), 'h1', eq.a.toFixed(3), 'h2', eq.b.toFixed(3));

