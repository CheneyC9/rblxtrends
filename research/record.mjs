// Hourly recorder for Roblox's Top Trending chart (own reads, same shape as the contest's history lines).
// Main read: device=computer, country=us (what the contest scores). Extras: other countries / devices as
// possible leading indicators. Appends one JSON line to data/live.ndjson. Node 22+, no dependencies.
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.env.RBLX_LIVE ?? join(HERE, '..', 'data', 'live.ndjson');
mkdirSync(dirname(OUT), { recursive: true });
const UA = 'rblxtrends-recorder/1.0 (personal forecasting research)';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
      if (res.status === 429) {
        await sleep(Math.min(30000, 1000 * Number(res.headers.get('retry-after') ?? 5)));
        continue;
      }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) return { error: String(e) };
      await sleep(1500 * (i + 1));
    }
  }
}

const explore = (sort, device, country) =>
  get(`https://apis.roblox.com/explore-api/v1/get-sort-content?sortId=${sort}&sessionId=${randomUUID()}&device=${device}&country=${country}`);

function rows(j, withVotes) {
  if (!j || !Array.isArray(j.games)) return null;
  let rank = 0;
  return j.games
    .filter((g) => !g.isSponsored)
    .map((g) => ({
      rank: ++rank,
      universe_id: g.universeId,
      root_place_id: g.rootPlaceId,
      name: g.name,
      playing: g.playerCount ?? null,
      ...(withVotes ? { up_votes: g.totalUpVotes ?? null, down_votes: g.totalDownVotes ?? null, genre: g.genreL1 ?? null } : {}),
    }));
}

const at = new Date().toISOString();
const main = await explore('top-trending', 'computer', 'us');
const tt = rows(main, true);
const pn = rows(await explore('top-playing-now', 'computer', 'us'), false);
let details = null;
if (tt) {
  const ids = tt.map((g) => g.universe_id);
  details = {};
  for (let i = 0; i < ids.length; i += 50) {
    const d = await get('https://games.roblox.com/v1/games?universeIds=' + ids.slice(i, i + 50).join(','));
    for (const g of d?.data ?? [])
      details[g.id] = { name: g.name, playing: g.playing, visits: g.visits, favorites: g.favoritedCount ?? null, max_players: g.maxPlayers, created: g.created, updated: g.updated, creator_name: g.creator?.name, creator_type: g.creator?.type, genre: g.genre };
  }
}
const extras = {};
for (const [k, device, country] of [
  ['gb', 'computer', 'gb'], ['de', 'computer', 'de'], ['br', 'computer', 'br'], ['fr', 'computer', 'fr'], ['jp', 'computer', 'jp'],
  ['kr', 'computer', 'kr'], ['mx', 'computer', 'mx'], ['ca', 'computer', 'ca'], ['au', 'computer', 'au'], ['ph', 'computer', 'ph'],
  ['us_phone', 'phone', 'us'], ['us_console', 'console', 'us'],
]) {
  await sleep(400);
  const r = rows(await explore('top-trending', device, country), false);
  if (r) extras[k] = r.map((g) => [g.universe_id, g.playing]);
}
const line = { schema: 'rblxtrends/live/v1', at, source: 'cheney/live-recorder', filters: { device: 'computer', country: 'us' }, ok: !!tt, top_trending: tt, top_playing_now: pn, details, extras };
appendFileSync(OUT, JSON.stringify(line) + '\n');
console.log(at, 'trending', tt?.length ?? 'FAIL', 'extras', Object.keys(extras).length);
