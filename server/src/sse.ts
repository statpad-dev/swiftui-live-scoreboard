import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GameHub } from './hub.js';
import type { Log } from './upstream.js';

// GET /games/:id returns what the hub holds. GET /games/:id/events streams it as server-sent
// events whose ids are Statpad seqs: a snapshot, or what a phone missed, then every change.
export function handler(hub: GameHub, log: Log) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const match = new URL(req.url ?? '/', 'http://localhost').pathname.match(/^\/games\/([0-9a-f-]{36})(\/events)?$/);
    if (!match || match[1] !== hub.gameId) return res.writeHead(404).end();
    if (!match[2]) return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(hub.snapshot()));

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
    const send = (event: 'snapshot' | 'changes', seq: number, data: unknown) =>
      res.write(`event: ${event}\nid: ${seq}\ndata: ${JSON.stringify(data)}\n\n`);
    const header = req.headers['last-event-id'];
    const missed = typeof header === 'string' ? hub.since(Number(header)) : undefined;
    if (missed) {
      if (missed.length > 0) send('changes', hub.seq, missed);
      log(`phone resumed after ${header}: ${missed.length} changes, now at ${hub.seq}`);
    } else {
      send('snapshot', hub.seq, hub.snapshot());
      log(`phone connected${header ? ` from ${header}` : ''}: snapshot at ${hub.seq}`);
    }
    const unsubscribe = hub.subscribe((event) => send(event.type, event.seq, event.data));
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      unsubscribe();
      clearInterval(ping);
      log(`phone disconnected at ${hub.seq}`);
    });
  };
}
