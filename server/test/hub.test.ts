import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Change } from '@statpad/sdk';
import { GameHub } from '../src/hub.js';

const journal: Change[] = readFileSync(new URL('../../data/nfl-bills-at-vikings/changes.ndjson', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));

test('a phone at 1101 gets exactly the scoreboard changes after it', () => {
  const hub = new GameHub('nfl', '01a1d60f-67be-7bdd-83f4-53286521d9bb');
  hub.apply(journal.slice(0, 1114));
  assert.deepEqual(hub.since(1101)?.map((c) => `${c.seq} ${c.entity_type}`), [
    '1102 live_state', '1104 game', '1106 play', '1107 live_state', '1108 game', '1111 play', '1112 live_state', '1113 play', '1114 live_state',
  ]);
});

test('the same change twice is ignored, a gap throws', () => {
  const hub = new GameHub('nfl', '01a1d60f-67be-7bdd-83f4-53286521d9bb');
  hub.apply(journal.slice(0, 100));
  hub.apply(journal.slice(50, 100));
  assert.equal(hub.seq, 100);
  assert.throws(() => hub.apply(journal.slice(101, 110)), /gap: holding 100, got 102/);
});

test('a delete removes the entity and is forwarded to phones', () => {
  const hub = new GameHub('nfl', '01a1d60f-67be-7bdd-83f4-53286521d9bb');
  hub.apply(journal.slice(0, 1114));
  const touchdown = journal[1111 - 1];
  // The recording has no deletes, so this tombstone is written by hand in the schema's shape.
  const tombstone = { ...touchdown, seq: 1115, op: 'delete', version: 3, payload: { id: touchdown.entity_id, version: 3, deleted_at: '2026-11-10T04:06:00Z' } } as Change;
  hub.apply([tombstone]);
  assert.equal(hub.snapshot().entities.some((e) => e.entity_id === touchdown.entity_id), false);
  assert.equal(hub.since(1114)?.[0].op, 'delete');
});

test('a phone further back than the journal, or ahead of it, gets a snapshot', () => {
  const hub = new GameHub('nfl', '01a1d60f-67be-7bdd-83f4-53286521d9bb');
  hub.apply(journal);
  assert.equal(hub.since(1277)?.length, 0);
  assert.equal(hub.since(1278), undefined);
  // 591 of the 1,277 changes are scoreboard types, under the 2,000 cap, so 0 still resolves.
  assert.equal(hub.since(0)?.length, journal.filter((c) => ['game', 'live_state', 'team', 'play'].includes(c.entity_type)).length);
});
