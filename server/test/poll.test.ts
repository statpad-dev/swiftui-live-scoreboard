import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { type Change, type Statpad, StatpadError } from '@statpad/sdk';
import { entitiesOf, GameHub } from '../src/hub.js';
import { pollChanges } from '../src/upstream.js';

// These tests run --poll against a stand-in for GET /v1/nfl/games/{id}/changes that serves the
// recorded Bills at Vikings journal, a page of at most `limit` changes after `after_seq`.
const GAME = '01a1d60f-67be-7bdd-83f4-53286521d9bb';
const data = (name: string) => readFileSync(new URL(`../../data/nfl-bills-at-vikings/${name}`, import.meta.url), 'utf8');
const journal: Change[] = data('changes.ndjson').trim().split('\n').map((line) => JSON.parse(line));
const final = JSON.parse(data('game.json'));
const log = (message: string) => console.log(`  [poll] ${message}`);
const noResync = () => Promise.reject(new Error('unexpected resync'));
const problem = (status: number, code: string, headers: Record<string, string> = {}) =>
  new StatpadError(new Response(null, { status, headers }), { code, detail: code, resets_at: '2026-12-01T00:00:00Z' });

// head(call) is the newest seq the feed holds on each call, so a test can play a game forward.
// fail(call) can throw instead of answering.
function feed(head: (call: number) => number, fail: (call: number) => StatpadError | undefined = () => undefined) {
  const calls: { after_seq: number; limit: number }[] = [];
  const statpad = {
    changes: {
      listGameChanges: async ({ query }: { query: { after_seq: number; limit: number } }) => {
        calls.push(query);
        const error = fail(calls.length);
        if (error) throw error;
        const head_seq = head(calls.length);
        const page = journal.slice(query.after_seq, Math.min(head_seq, query.after_seq + query.limit));
        return { data: { stream: `game:${GAME}`, data: page, head_seq, min_seq: 1 } };
      },
    },
  } as unknown as Statpad;
  return { statpad, calls };
}

function hub() {
  const hub = new GameHub('nfl', GAME);
  hub.load(0, entitiesOf(final).filter((e) => e.entity_type === 'team'));
  return hub;
}

test('polling pages while behind, then stops once the game is complete', async () => {
  const { statpad, calls } = feed(() => 1277);
  const game = hub();
  await pollChanges(game, statpad, noResync, log, { intervalMs: 1 });
  assert.equal(game.seq, 1277);
  assert.deepEqual(calls.map((c) => c.after_seq), [0, 1000]);
});

test('a live game is polled again after each wait until the final arrives', async () => {
  const heads = [1101, 1101, 1114, 1277];
  const { statpad, calls } = feed((call) => heads[Math.min(call, heads.length) - 1]);
  const game = hub();
  await pollChanges(game, statpad, noResync, log, { intervalMs: 1 });
  assert.equal(game.seq, 1277);
  assert.deepEqual(calls.map((c) => c.after_seq), [0, 1000, 1101, 1114]);
});

test('quota_exhausted stops polling', async () => {
  const { statpad, calls } = feed(() => 1101, (call) => (call === 2 ? problem(429, 'quota_exhausted') : undefined));
  const game = hub();
  await pollChanges(game, statpad, noResync, log, { intervalMs: 1 });
  assert.equal(calls.length, 2);
  assert.equal(game.seq, 1000);
});

test('rate_limited waits Retry-After and polls again from the same seq', async () => {
  const { statpad, calls } = feed(() => 1277, (call) => (call === 1 ? problem(429, 'rate_limited', { 'Retry-After': '1' }) : undefined));
  const started = Date.now();
  await pollChanges(hub(), statpad, noResync, log, { intervalMs: 1 });
  assert.ok(Date.now() - started >= 1_000);
  assert.deepEqual(calls.map((c) => c.after_seq), [0, 0, 1000]);
});

test('resync_required reads the game again and polls from its seq', async () => {
  const { statpad, calls } = feed(() => 1277, (call) => (call === 1 ? problem(410, 'resync_required') : undefined));
  const game = hub();
  const resync = async () => ({ seq: 1101, entities: entitiesOf(JSON.parse(data('game-live.json'))) });
  await pollChanges(game, statpad, resync, log, { intervalMs: 1 });
  assert.equal(game.seq, 1277);
  assert.deepEqual(calls.map((c) => c.after_seq), [0, 1101]);
});
