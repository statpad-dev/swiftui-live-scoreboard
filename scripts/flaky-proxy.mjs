// A TCP proxy for the reconnect demo. The Simulator has no airplane mode, so the app talks to
// :8788, and stopping this process cuts the phone off without touching the server on :8787.
import { connect, createServer } from 'node:net';

const [listen = 8788, target = 8787] = process.argv.slice(2).map(Number);
createServer((client) => {
  const upstream = connect(target, '127.0.0.1');
  client.pipe(upstream).pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
}).listen(listen, () => console.log(`proxy :${listen} -> :${target}`));
