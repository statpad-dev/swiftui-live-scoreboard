import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { Change } from '@statpad/sdk';
import { type WebSocket, WebSocketServer } from 'ws';
import { type Entity, entitiesOf, GameHub, type Snapshot } from '../src/hub.js';
import { followStream } from '../src/upstream.js';

// These tests run followStream against a local stand-in for wss://stream.statpad.dev that
// follows api/src/asyncapi.yaml and serves the recorded Bills at Vikings journal.
const GAME = '01a1d60f-67be-7bdd-83f4-53286521d9bb';
const STREAM = `game:${GAME}`;
const journal: Change[] = readFileSync(new URL('../../data/nfl-bills-at-vikings/changes.ndjson', import.meta.url), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));

type Script = (connection: number, ws: WebSocket, resume: number) => void;

// tooOld marks the resume points the gateway refuses with an error (resync_required unless
// refusal names another code) instead of subscribed, and silent the connections it accepts
// without ever sending welcome.
async function gateway(
  script: Script,
  {
    heartbeatSeconds = 5,
    tooOld = (_resume: number): boolean => false,
    refusal = 'resync_required',
    silent = (_connection: number): boolean => false,
  } = {},
) {
  const server = new WebSocketServer({ port: 0 });
  await new Promise((resolve) => server.once('listening', resolve));
  const subscribes: unknown[] = [];
  const auth: (string | undefined)[] = [];
  const sockets: WebSocket[] = [];
  server.on('connection', (ws, req) => {
    const connection = sockets.push(ws);
    auth.push(req.headers.authorization);
    if (silent(connection)) return;
    ws.send(JSON.stringify({ type: 'welcome', connection_id: `c${connection}`, plan: 'pro', heartbeat_seconds: heartbeatSeconds, max_subscriptions: 20, payload_version: 1 }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      subscribes.push(msg);
      const resume = msg.resume[STREAM];
      if (tooOld(resume)) {
        return ws.send(JSON.stringify({ type: 'error', id: msg.id, stream: STREAM, code: refusal, message: `resume seq ${resume} refused`, min_seq: 1102 }));
      }
      ws.send(JSON.stringify({ type: 'subscribed', id: msg.id, stream: STREAM, mode: 'resume', seq: resume }));
      script(connection, ws, resume);
    });
  });
  const url = `ws://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, subscribes, auth, sockets, close: () => server.close() };
}

// A catch-up reads the journal in pages of 500 changes (changesPerMessage in internal/api/stream).
function send(ws: WebSocket, after: number, through: number) {
  for (let seq = after + 1; seq <= through; seq += 500) {
    ws.send(JSON.stringify({ type: 'changes', stream: STREAM, changes: journal.slice(seq - 1, Math.min(seq + 499, through)) }));
  }
}

async function until(condition: () => boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await sleep(20);
  }
}

function score(hub: GameHub) {
  const game = hub.snapshot().entities.find((e) => e.entity_type === 'game')?.payload as { away_score: number; home_score: number };
  return `${game.away_score}-${game.home_score}`;
}

const log = (name: string) => (message: string) => console.log(`  [${name}] ${message}`);
const noResync = () => Promise.reject(new Error('unexpected resync'));

test('a 1001 close resumes from the last applied seq', async () => {
  const gw = await gateway((connection, ws, resume) => {
    if (connection === 1) {
      send(ws, resume, 1101);
      setTimeout(() => ws.close(1001, 'restarting'), 50);
    } else {
      send(ws, resume, 1277);
    }
  });
  const hub = new GameHub('nfl', GAME);
  const stop = followStream(hub, { key: 'test-key', url: gw.url, resync: noResync, log: log('1001') });
  await until(() => hub.seq === 1277);
  stop();
  gw.close();
  assert.deepEqual(gw.subscribes, [
    { type: 'subscribe', id: 'g1', streams: [STREAM], resume: { [STREAM]: 0 } },
    { type: 'subscribe', id: 'g1', streams: [STREAM], resume: { [STREAM]: 1101 } },
  ]);
  assert.deepEqual(gw.auth, ['Bearer test-key', 'Bearer test-key']);
  assert.equal(score(hub), '23-6');
});

const read = (name: string) => JSON.parse(readFileSync(new URL(`../../data/nfl-bills-at-vikings/${name}`, import.meta.url), 'utf8'));
const live = read('game-live.json');
const final = read('game.json');
const at1101: Snapshot = { seq: live.seq, entities: [{ entity_type: 'game', entity_id: GAME, version: live.game.version, payload: live.game } as Entity] };
const tooOld = (resume: number) => resume < 1101;

test('resync_required reads the game again and resumes from its seq', async () => {
  const gw = await gateway((_, ws, resume) => send(ws, resume, 1277), { tooOld });
  const hub = new GameHub('nfl', GAME);
  const resync = async () => at1101;
  const stop = followStream(hub, { key: 'test-key', url: gw.url, resync, log: log('resync') });
  await until(() => hub.seq === 1277);
  stop();
  gw.close();
  assert.deepEqual(gw.subscribes.map((s) => (s as { resume: Record<string, number> }).resume[STREAM]), [0, 1101]);
  assert.equal(score(hub), '23-6');
});

test('invalid_resume, a seq past the stream\'s head, reads the game again too', async () => {
  const gw = await gateway((_, ws, resume) => send(ws, resume, 1277), { tooOld: (resume) => resume > 1277, refusal: 'invalid_resume' });
  const hub = new GameHub('nfl', GAME);
  hub.load(1500, []);
  const stop = followStream(hub, { key: 'test-key', url: gw.url, resync: async () => at1101, log: log('invalid resume') });
  await until(() => hub.seq === 1277);
  stop();
  gw.close();
  assert.deepEqual(gw.subscribes.map((s) => (s as { resume: Record<string, number> }).resume[STREAM]), [1500, 1101]);
  assert.equal(score(hub), '23-6');
});

test('quota_exhausted stops following instead of subscribing again', async () => {
  const gw = await gateway(() => {}, { tooOld: () => true, refusal: 'quota_exhausted' });
  const hub = new GameHub('nfl', GAME);
  const lines: string[] = [];
  const stop = followStream(hub, { key: 'test-key', url: gw.url, resync: noResync, log: (m) => (lines.push(m), log('quota')(m)) });
  await until(() => lines.includes('stopped following the stream'));
  await sleep(1_500);
  stop();
  gw.close();
  assert.equal(gw.sockets.length, 1);
  assert.equal(gw.subscribes.length, 1);
});

test('a resync that fails reconnects with backoff, still at the old seq, and tries again', async () => {
  const gw = await gateway((_, ws, resume) => send(ws, resume, 1277), { tooOld });
  const hub = new GameHub('nfl', GAME);
  const lines: string[] = [];
  let calls = 0;
  const resync = async () => {
    if (++calls <= 2) throw new Error('getGame: 503 Service Unavailable');
    return at1101;
  };
  const stop = followStream(hub, { key: 'test-key', url: gw.url, resync, log: (m) => (lines.push(m), log('resync failed')(m)) });
  await until(() => hub.seq === 1277);
  stop();
  gw.close();
  assert.equal(calls, 3);
  assert.deepEqual(gw.subscribes.map((s) => (s as { resume: Record<string, number> }).resume[STREAM]), [0, 0, 0, 1101]);
  assert.deepEqual(lines.filter((l) => l.startsWith('closed')).map((l) => l.replace(/^closed \d+, /, '')), ['resuming after 0 in 1000 ms', 'resuming after 0 in 2000 ms']);
  assert.equal(score(hub), '23-6');
});

test('a read that finishes after its socket closed never reaches the hub', async () => {
  const gw = await gateway(() => {}, { tooOld: (resume) => resume === 0 });
  const hub = new GameHub('nfl', GAME);
  const snapshots: number[] = [];
  hub.subscribe((event) => event.type === 'snapshot' && snapshots.push(event.seq));
  const signals: AbortSignal[] = [];
  let release = () => {};
  const released = new Promise<void>((resolve) => (release = resolve));
  // The first read is slow and ignores its signal, as a fetch already past the network might.
  const resync = async (signal: AbortSignal) => {
    signals.push(signal);
    if (signals.length === 1) {
      await released;
      return at1101;
    }
    return { seq: final.seq, entities: entitiesOf(final) };
  };
  const stop = followStream(hub, { key: 'test-key', url: gw.url, resync, log: log('stale read') });
  await until(() => signals.length === 1);
  gw.sockets[0].close(1001, 'restarting');
  await until(() => hub.seq === 1277 && gw.subscribes.length === 3);
  release();
  await sleep(50);
  stop();
  gw.close();
  assert.equal(signals[0].aborted, true);
  assert.deepEqual(snapshots, [1277]);
  assert.equal(hub.seq, 1277);
  assert.deepEqual(gw.subscribes.map((s) => (s as { resume: Record<string, number> }).resume[STREAM]), [0, 0, 1277]);
});

test('a catch-up after 604 ends its first message on the 19-6 score, before the touchdown play', async () => {
  const gw = await gateway((_, ws, resume) => send(ws, resume, 1277));
  const hub = new GameHub('nfl', GAME);
  hub.apply(journal.slice(0, 604));
  const events: { seq: number; changes: Change[] }[] = [];
  hub.subscribe((event) => event.type === 'changes' && events.push({ seq: event.seq, changes: event.data }));
  const stop = followStream(hub, { key: 'test-key', url: gw.url, resync: noResync, log: log('604') });
  await until(() => hub.seq === 1277);
  stop();
  gw.close();
  const [first, second] = events;
  const score = first.changes.findLast((c) => c.entity_type === 'game')!;
  const touchdown = journal[1106 - 1];
  assert.equal(first.seq, 1104);
  assert.equal(score.seq, 1104);
  assert.equal(score.at, touchdown.at);
  assert.equal(first.changes.some((c) => c.entity_id === touchdown.entity_id), false);
  assert.equal(second.changes.find((c) => c.entity_id === touchdown.entity_id)?.seq, 1106);
});

test('four heartbeats of silence reconnect and resume', async () => {
  const gw = await gateway((connection, ws, resume) => send(ws, resume, connection === 1 ? 640 : 1277), { heartbeatSeconds: 1 });
  const hub = new GameHub('nfl', GAME);
  const stop = followStream(hub, { key: 'test-key', url: gw.url, resync: noResync, log: log('heartbeat') });
  await until(() => hub.seq === 1277);
  stop();
  gw.close();
  assert.deepEqual(gw.subscribes.map((s) => (s as { resume: Record<string, number> }).resume[STREAM]), [0, 640]);
});

test('a gateway that accepts the socket but never says welcome is dropped after four heartbeats', async () => {
  const gw = await gateway((_, ws, resume) => send(ws, resume, 1277), { heartbeatSeconds: 1, silent: (connection) => connection === 1 });
  const hub = new GameHub('nfl', GAME);
  const stop = followStream(hub, { key: 'test-key', url: gw.url, heartbeatSeconds: 1, resync: noResync, log: log('no welcome') });
  await until(() => hub.seq === 1277);
  stop();
  gw.close();
  assert.equal(gw.sockets.length, 2);
  assert.deepEqual(gw.subscribes.map((s) => (s as { resume: Record<string, number> }).resume[STREAM]), [0]);
});

test('stop() during the backoff cancels the reconnect', async () => {
  const gw = await gateway((_, ws) => ws.close(1001, 'restarting'));
  const hub = new GameHub('nfl', GAME);
  const lines: string[] = [];
  const stop = followStream(hub, { key: 'test-key', url: gw.url, resync: noResync, log: (m) => (lines.push(m), log('stop')(m)) });
  await until(() => lines.some((l) => l.startsWith('closed 1001')));
  stop();
  await sleep(1_500);
  gw.close();
  assert.equal(gw.sockets.length, 1);
});
