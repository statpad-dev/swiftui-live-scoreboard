import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { type Change, type Game, paginate, type Play, type Statpad, StatpadError } from '@statpad/sdk';
import { type Entity, entitiesOf, type GameHub, type Snapshot } from './hub.js';

export type Log = (message: string) => void;

// Reads the game and its plays over REST, for the caller to pass to hub.load. The seq is the
// lowest the reads returned, so changes made between the reads are applied again.
export async function readGame(game: Pick<GameHub, 'league' | 'gameId'>, statpad: Statpad, log: Log, signal?: AbortSignal): Promise<Snapshot> {
  const path = { league: game.league, game_id: game.gameId };
  const { data: detail } = await statpad.games.getGame({ path, signal });
  let seq = detail.seq;
  const plays: Entity[] = [];
  for await (const page of paginate(statpad.playByPlay.listPlays, { path, signal })) {
    seq = Math.min(seq, page.seq);
    for (const play of page.data) plays.push({ entity_type: 'play', entity_id: play.id, version: play.version, payload: play });
  }
  log(`read game at seq ${seq}: ${detail.game.away_score}-${detail.game.home_score}, ${plays.length} plays`);
  return { seq, entities: [...entitiesOf(detail), ...plays] };
}

// Pro, Business and the Pro trial: one WebSocket, one subscription, resumed from hub.seq on every reconnect.
export function followStream(
  hub: GameHub,
  {
    key,
    resync,
    log,
    url = 'wss://stream.statpad.dev/v1/stream',
    heartbeatSeconds = 5,
  }: { key: string; resync: (signal: AbortSignal) => Promise<Snapshot>; log: Log; url?: string; heartbeatSeconds?: number },
) {
  const stream = `game:${hub.gameId}`;
  let attempt = 0;
  let stopped = false;
  let current: WebSocket | undefined;
  let retry: NodeJS.Timeout | undefined;
  // The REST read in flight. A close, a newer read or stop() aborts it, and an aborted read
  // never reaches the hub, however late it finishes.
  let reading: AbortController | undefined;
  const connect = () => {
    const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${key}` } });
    current = ws;
    let heartbeatMs = heartbeatSeconds * 1_000;
    let watchdog: NodeJS.Timeout | undefined;
    let later: NodeJS.Timeout | undefined;
    // The gateway sends a heartbeat every 5 seconds and can pause it for up to 10 while it waits
    // for a ping reply, so 20 seconds of silence (four heartbeats) means the socket is dead.
    const alive = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => {
        log('no message for four heartbeats, reconnecting');
        ws.terminate();
      }, 4 * heartbeatMs);
    };
    const subscribe = () => {
      log(`subscribe ${stream} resume after ${hub.seq}`);
      ws.send(JSON.stringify({ type: 'subscribe', id: 'g1', streams: [stream], resume: { [stream]: hub.seq } }));
    };
    const resubscribeFromRest = async () => {
      reading?.abort();
      const read = (reading = new AbortController());
      try {
        const state = await resync(read.signal);
        if (read.signal.aborted) return log(`dropped a read at seq ${state.seq} that finished after its socket closed`);
        hub.load(state.seq, state.entities);
        subscribe();
      } catch (error) {
        if (read.signal.aborted) return;
        log(`resync failed, reconnecting: ${error}`);
        ws.close();
      }
    };
    alive();
    ws.on('message', (raw) => {
      alive();
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'welcome') {
        heartbeatMs = msg.heartbeat_seconds * 1_000;
        subscribe();
      } else if (msg.type === 'subscribed') {
        attempt = 0;
        log(`subscribed (${msg.mode}) at ${msg.seq}`);
      } else if (msg.type === 'changes') {
        try {
          hub.apply(msg.changes);
        } catch (error) {
          log(String(error));
          ws.close();
        }
      } else if (msg.type === 'error') {
        log(`error ${msg.code}: ${msg.message}`);
        // What to do for each code, from statpad.dev/docs/streaming#handle-stream-errors.
        switch (msg.code) {
          case 'slow_consumer':
          case 'internal':
            subscribe();
            break;
          case 'unavailable':
            later = setTimeout(subscribe, 5_000);
            break;
          case 'rate_limited':
            later = setTimeout(subscribe, msg.retry_after * 1_000);
            break;
          case 'resync_required':
          case 'invalid_resume':
            resubscribeFromRest();
            break;
          default:
            log('stopped following the stream');
            stopped = true;
            ws.close();
        }
      }
    });
    ws.on('error', (error) => log(`socket error: ${error.message}`));
    ws.on('close', (code) => {
      clearTimeout(watchdog);
      clearTimeout(later);
      reading?.abort();
      if (stopped) return;
      if (code === 1008) return log('closed 1008: the key was rejected or the plan has no streaming access. On Free or Developer, run with --poll');
      const delay = Math.min(30_000, 1_000 * 2 ** attempt++);
      log(`closed ${code}, resuming after ${hub.seq} in ${delay} ms`);
      retry = setTimeout(connect, delay);
    });
  };
  connect();
  return () => {
    stopped = true;
    clearTimeout(retry);
    reading?.abort();
    current?.close();
  };
}

// The statuses after which a game gets no more scoreboard changes worth a request.
const OVER = new Set(['complete', 'closed', 'cancelled', 'postponed']);

// Free and Developer have no stream, so --poll reads the game's changes feed instead: pages at
// once while behind, then every 5 seconds, backing off after failures. Each poll counts against
// the month's allowance, so it stops after the final and on quota_exhausted.
export async function pollChanges(
  hub: GameHub,
  statpad: Statpad,
  resync: () => Promise<Snapshot>,
  log: Log,
  { intervalMs = 5_000 }: { intervalMs?: number } = {},
) {
  const path = { league: hub.league, game_id: hub.gameId };
  let failures = 0;
  let polls = 0;
  while (true) {
    try {
      polls++;
      const { data: page } = await statpad.changes.listGameChanges({ path, query: { after_seq: hub.seq, limit: 1000 } });
      hub.apply(page.data);
      failures = 0;
      if (hub.seq < page.head_seq) continue;
      const status = (hub.snapshot().entities.find((e) => e.entity_type === 'game')?.payload as Game | undefined)?.status;
      if (status && OVER.has(status)) return log(`the game is ${status}, stopped polling at seq ${hub.seq} after ${polls} polls`);
    } catch (error) {
      if (error instanceof StatpadError && error.code === 'quota_exhausted') {
        return log(`quota_exhausted: stopped polling at seq ${hub.seq} until ${error.resetsAt}`);
      }
      if (error instanceof StatpadError && error.code === 'rate_limited') {
        await sleep((error.retryAfter ?? 1) * 1_000);
        continue;
      }
      failures++;
      if (error instanceof StatpadError && error.code === 'resync_required') {
        await resync().then(
          (state) => {
            hub.load(state.seq, state.entities);
            failures = 0;
          },
          (failure) => log(`resync failed: ${failure}`),
        );
      } else {
        log(`poll failed: ${error}`);
      }
    }
    await sleep(Math.min(60_000, intervalMs * 2 ** failures));
  }
}

// No key, no live game: the recorded Bills at Vikings journal, paced by each play's wall_clock.
export async function replay(
  hub: GameHub,
  source: string,
  { from, until, speed, hold }: { from: number; until: number; speed: number; hold: number },
  log: Log,
) {
  const read = async (name: string) =>
    source.startsWith('https://') ? (await fetch(`${source}/${name}`)).text() : readFile(join(source, name), 'utf8');
  const final = JSON.parse(await read('game.json'));
  const changes: Change[] = (await read('changes.ndjson')).trim().split('\n').map((line) => JSON.parse(line));
  // Teams travel on league:nfl, not the game stream, so they come from the game read.
  hub.load(0, entitiesOf(final).filter((e) => e.entity_type === 'team'));
  // append_changes stamps one transaction's changes with one clock_timestamp(), so equal
  // `at` values mark the changes Statpad committed together.
  const batches: Change[][] = [];
  for (const c of changes) {
    if (batches.at(-1)?.[0].at === c.at) batches.at(-1)!.push(c);
    else batches.push([c]);
  }
  let clock = 0;
  for (const batch of batches) {
    const wall = Math.max(0, ...batch.filter((c) => c.entity_type === 'play').map((c) => Date.parse((c.payload as Play).wall_clock ?? '')).filter(Number.isFinite));
    if (hub.seq >= from && clock > 0 && wall > clock) await sleep((wall - clock) / speed);
    clock = Math.max(clock, wall);
    const before = hub.seq;
    hub.apply(batch);
    if (before < from && hub.seq >= from && hold > 0) {
      log(`replay holding at seq ${hub.seq} for ${hold} s`);
      await sleep(hold * 1_000);
    }
    if (hub.seq >= until) return log(`replay stopped at seq ${hub.seq}`);
  }
  log(`replay finished at seq ${hub.seq}`);
}
