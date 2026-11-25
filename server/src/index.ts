import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { parseArgs } from 'node:util';
import { Statpad } from '@statpad/sdk';
import { GameHub } from './hub.js';
import { handler } from './sse.js';
import { followStream, pollChanges, readGame, replay } from './upstream.js';

const { values: args } = parseArgs({
  options: {
    game: { type: 'string', default: '01a1d60f-67be-7bdd-83f4-53286521d9bb' },
    port: { type: 'string', default: '8787' },
    poll: { type: 'boolean', default: false },
    replay: { type: 'string' },
    from: { type: 'string', default: '0' },
    until: { type: 'string', default: 'Infinity' },
    speed: { type: 'string', default: '1' },
    hold: { type: 'string', default: '0' },
  },
});
if (existsSync('.env')) process.loadEnvFile('.env');
const log = (message: string) => console.log(`${new Date().toISOString().slice(11, 23)} ${message}`);
const hub = new GameHub('nfl', args.game);

hub.subscribe(({ type, seq, data: changes }) => {
  if (type !== 'changes' || seq <= Number(args.from)) return;
  const game = changes.findLast((c) => c.entity_type === 'game')?.payload as { away_score: number; home_score: number } | undefined;
  const play = changes.findLast((c) => c.entity_type === 'play');
  if (game || play) log(`seq ${seq}: ${game ? `${game.away_score}-${game.home_score} ` : ''}${play ? `play v${play.version} ${(play.payload as { description: string }).description}` : ''}`);
});

if (args.replay !== undefined) {
  const options = { from: Number(args.from), until: Number(args.until), speed: Number(args.speed), hold: Number(args.hold) };
  replay(hub, args.replay || 'https://statpad.dev/samples/nfl-bills-at-vikings', options, log);
} else {
  const key = process.env.STATPAD_API_KEY;
  if (!key) throw new Error('Set STATPAD_API_KEY in server/.env or the environment, or run with --replay');
  const statpad = new Statpad({ apiKey: key });
  const resync = (signal?: AbortSignal) => readGame(hub, statpad, log, signal);
  const { seq, entities } = await resync();
  hub.load(seq, entities);
  if (args.poll) pollChanges(hub, statpad, resync, log);
  else followStream(hub, { key, resync, log });
}

createServer(handler(hub, log)).listen(Number(args.port), () => log(`listening on :${args.port}, game ${hub.gameId}`));
