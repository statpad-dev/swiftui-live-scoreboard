import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { get, type IncomingMessage, createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { Change, Play, Statpad } from '@statpad/sdk';
import { GameHub, type Snapshot } from '../src/hub.js';
import { handler } from '../src/sse.js';
import { readGame } from '../src/upstream.js';

const GAME = '01a1d60f-67be-7bdd-83f4-53286521d9bb';
const data = (name: string) => readFileSync(new URL(`../../data/nfl-bills-at-vikings/${name}`, import.meta.url), 'utf8');
const journal: Change[] = data('changes.ndjson').trim().split('\n').map((line) => JSON.parse(line));
const log = (message: string) => console.log(`  [sse] ${message}`);

// A stand-in for the SDK client that answers getGame with game.json (seq 1277, 23-6) and
// listPlays with each play's last version from the journal, 100 to a page, leaving out one.
function statpad(without: string): Statpad {
  const plays = [...new Map(journal.filter((c) => c.entity_type === 'play').map((c) => [c.entity_id, c.payload as Play])).values()].filter((p) => p.id !== without);
  return {
    games: { getGame: async () => ({ data: JSON.parse(data('game.json')) }) },
    playByPlay: {
      listPlays: async ({ query }: { query?: { cursor?: string } }) => {
        const start = Number(query?.cursor ?? 0);
        const next = start + 100 < plays.length ? String(start + 100) : null;
        return { data: { data: plays.slice(start, start + 100), next_cursor: next, seq: 1277 } };
      },
    },
  } as unknown as Statpad;
}

// Reads server-sent events from a response into a list.
function events(res: IncomingMessage) {
  const received: { event: string; id: number; data: Snapshot }[] = [];
  let buffer = '';
  res.setEncoding('utf8');
  res.on('data', (chunk: string) => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const fields = Object.fromEntries(buffer.slice(0, end).split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 2)]));
      buffer = buffer.slice(end + 2);
      if (fields.event) received.push({ event: fields.event, id: Number(fields.id), data: JSON.parse(fields.data) });
    }
  });
  return received;
}

async function until(condition: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(20);
  }
}

const score = (snapshot: Snapshot) => {
  const game = snapshot.entities.find((e) => e.entity_type === 'game')?.payload as { away_score: number; home_score: number };
  return `${game.away_score}-${game.home_score}`;
};

test('a resync with no later changes reaches a connected phone as a snapshot', async () => {
  const hub = new GameHub('nfl', GAME);
  hub.apply(journal.slice(0, 1101));
  const server = createServer(handler(hub, log)).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address() as { port: number };
  const res = await new Promise<IncomingMessage>((resolve) => get(`http://127.0.0.1:${port}/games/${GAME}/events`, resolve));
  const received = events(res);
  await until(() => received.length === 1);
  assert.equal(received[0].event, 'snapshot');
  assert.equal(score(received[0].data), '13-6');

  // The read leaves out a play the hub holds, as if Statpad deleted it while the hub was away.
  const stale = journal.slice(0, 1101).findLast((c) => c.entity_type === 'play')!.entity_id;
  assert.equal(received[0].data.entities.some((e) => e.entity_id === stale), true);
  const { seq, entities } = await readGame(hub, statpad(stale), log);
  hub.load(seq, entities);
  await until(() => received.length === 2);
  res.destroy();
  server.close();
  const [, reset] = received;
  assert.equal(reset.event, 'snapshot');
  assert.equal(reset.id, 1277);
  assert.equal(score(reset.data), '23-6');
  const count = (type: string) => reset.data.entities.filter((e) => e.entity_type === type).length;
  assert.deepEqual([count('game'), count('live_state'), count('team'), count('play')], [1, 1, 2, 186]);
  assert.equal(reset.data.entities.some((e) => e.entity_id === stale), false);
});
