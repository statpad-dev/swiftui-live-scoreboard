// Prints every number the post quotes, computed from the recorded sample.
// Usage: node scripts/facts.mjs <path to samples/nfl-bills-at-vikings>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2];
const changes = readFileSync(join(dir, 'changes.ndjson'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const live = JSON.parse(readFileSync(join(dir, 'game-live.json'), 'utf8'));
const final = JSON.parse(readFileSync(join(dir, 'game.json'), 'utf8'));

const byType = {};
const bytesByType = {};
for (const c of changes) {
  byType[c.entity_type] = (byType[c.entity_type] ?? 0) + 1;
  bytesByType[c.entity_type] = (bytesByType[c.entity_type] ?? 0) + Buffer.byteLength(JSON.stringify(c));
}
const gaps = changes.filter((c, i) => c.seq !== i + 1).length;
const ops = [...new Set(changes.map((c) => c.op))];
console.log('changes', changes.length, 'first', changes[0].seq, 'last', changes.at(-1).seq, 'gaps', gaps, 'ops', ops);
console.log('by type', byType);
console.log('bytes by type', bytesByType);

const liveStates = changes.filter((c) => c.entity_type === 'live_state');
console.log('live_state with clock_running null', liveStates.filter((c) => c.payload.clock_running === null).length, 'of', liveStates.length);

const plays = changes.filter((c) => c.entity_type === 'play');
const wall = plays.map((c) => c.payload.wall_clock).filter(Boolean).sort();
console.log('play wall_clock', wall[0], 'to', wall.at(-1));
const at = changes.map((c) => c.at).sort();
console.log('change at', at[0], 'to', at.at(-1));
const playVersions = new Map();
for (const c of plays) playVersions.set(c.entity_id, Math.max(playVersions.get(c.entity_id) ?? 0, c.version));
console.log('distinct plays', playVersions.size, 'revised (version >= 2)', [...playVersions.values()].filter((v) => v >= 2).length);

console.log('distinct at values', new Set(changes.map((c) => c.at)).size);

console.log('\ngame-live.json seq', live.seq, 'score', live.game.away_score, live.game.home_score, 'period', live.live_state.period, 'clock', live.live_state.clock_seconds, 'football', JSON.stringify(live.live_state.football));
console.log('game.json seq', final.seq, 'status', final.game.status, 'score', final.game.away_score, final.game.home_score, 'started', final.game.started_at, 'ended', final.game.ended_at);

const lo = Number(process.argv[3] ?? 1095), hi = Number(process.argv[4] ?? 1115);
console.log('\nseq', lo, 'to', hi);
for (const c of changes.filter((c) => c.seq >= lo && c.seq <= hi)) {
  const p = c.payload;
  let what = '';
  if (c.entity_type === 'game') what = `status ${p.status} ${p.away_score}-${p.home_score}`;
  if (c.entity_type === 'live_state') what = `Q${p.period} clock ${p.clock_seconds} ${p.away_score}-${p.home_score} ${JSON.stringify(p.football)} last_play ${p.last_play_id?.slice(-6)}`;
  if (c.entity_type === 'play') what = `v${c.version} ${p.type} seq${p.sequence} wall ${p.wall_clock} ${p.description}`;
  if (c.entity_type === 'play_group') what = `v${c.version} ${JSON.stringify(p).slice(0, 200)}`;
  console.log(c.seq, c.at, c.entity_type, c.entity_id.slice(-6), what);
}
