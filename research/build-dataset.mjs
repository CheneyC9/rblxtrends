// Merge every source of reads into data/all.json: [{t, order:[uid...], playing:{uid:n}, src}] sorted by time.
// Sources: the kit's history (Oct 30 - Nov 5), the Kenny-Dhub archive git history (to now), my own hourly reads.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const reads = [];

// 1. the kit's history (also holds the house recorder's hourly reads once the final kit exists)
for (const f of ['roblox-trending-forecast-01-kit/input/history.ndjson']) {
  const p = join(ROOT, f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const d = JSON.parse(line);
    if (!d.ok || !d.top_trending?.length) continue;
    const playing = {};
    for (const g of d.top_trending) playing[g.universe_id] = g.playing;
    reads.push({ t: Date.parse(d.at), order: d.top_trending.map((g) => g.universe_id), playing, src: 'kit' });
  }
}

// 2. the public archive, every commit of data/discover/latest.json
const archive = join(ROOT, 'archive');
const log = execFileSync('git', ['-C', archive, 'log', '--format=%H %cI'], { encoding: 'utf8' }).trim().split('\n');
const seen = new Set(reads.map((r) => Math.round(r.t / 60000)));
for (const l of log) {
  const [sha] = l.split(' ');
  let j;
  try {
    j = JSON.parse(execFileSync('git', ['-C', archive, 'show', `${sha}:data/discover/latest.json`], { encoding: 'utf8', maxBuffer: 1 << 28 }));
  } catch {
    continue;
  }
  const t = Date.parse(j.generated_at);
  if (!Number.isFinite(t)) continue;
  const rows = [];
  for (const c of j.candidates ?? [])
    for (const s of c.sources ?? []) if (s.source === 'explore:top-trending') rows.push([s.rank, Number(c.universe_id), s.playing]);
  if (rows.length < 50) continue;
  // the kit already holds some of these reads, within a few minutes: skip a read the kit has
  if ([...Array(15).keys()].some((d) => seen.has(Math.round(t / 60000) + d - 7))) continue;
  rows.sort((a, b) => a[0] - b[0]);
  const playing = {};
  for (const r of rows) playing[r[1]] = r[2];
  reads.push({ t, order: rows.map((r) => r[1]), playing, src: 'archive' });
}

// 3. my own hourly reads
const live = join(ROOT, 'data', 'live.ndjson');
if (existsSync(live))
  for (const line of readFileSync(live, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const d = JSON.parse(line);
    if (!d.ok || !d.top_trending?.length) continue;
    const playing = {};
    for (const g of d.top_trending) playing[g.universe_id] = g.playing;
    reads.push({ t: Date.parse(d.at), order: d.top_trending.map((g) => g.universe_id), playing, src: 'live', extras: d.extras });
  }

reads.sort((a, b) => a.t - b.t);
writeFileSync(join(ROOT, 'data', 'all.json'), JSON.stringify(reads));
const gaps = reads.slice(1).map((r, i) => (r.t - reads[i].t) / 3.6e6);
console.log(reads.length, 'reads', new Date(reads[0].t).toISOString(), '->', new Date(reads.at(-1).t).toISOString(), 'median gap h', gaps.sort((a, b) => a - b)[gaps.length >> 1].toFixed(1));
console.log(reads.map((r) => r.src[0]).join(''));
