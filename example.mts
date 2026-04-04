/**
 * Hello World HTTP server — performance baseline for autocannon benchmarks.
 *
 * Responds to every request with a plain-text "Hello, World!" body.
 * GET /stop  — shuts the server down gracefully.
 *
 * Run:   PORT=3000 cargo run -- example.mts
 * Bench: autocannon -c 100 -d 10 http://127.0.0.1:$PORT/
 * Stop:  curl http://127.0.0.1:$PORT/stop
 */

import { serve } from 'fino:net/serve';
import { Response } from 'fino:net/http';
import { env } from 'fino:runtime/process';

const HOST = '127.0.0.1';
const PORT = Number(env.PORT || '3000');

const server = serve({ hostname: HOST, port: PORT }, async (req) => {
  const url = new URL(req.url);
  if (url.pathname === '/stop') {
    setTimeout(() => server.close(), 0);
    return new Response('stopped\n', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  }
  return new Response('Hello, World!', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
});

console.log(`Listening on http://${HOST}:${PORT}/`);
console.log(`Stop:  curl http://${HOST}:${PORT}/stop`);
