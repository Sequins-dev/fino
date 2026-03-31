/**
 * Hello World HTTP server — performance baseline for autocannon benchmarks.
 *
 * Responds to every request with a plain-text "Hello, World!" body.
 *
 * Run:  cargo run -- example.mts
 * Bench: autocannon -c 100 -d 10 http://127.0.0.1:3000/
 */

import { serve } from 'boats:net/serve';
import * as loop from 'boats:runtime/loop';

const HOST = '127.0.0.1';
const PORT = 3000;

const lp = loop.create();

const server = serve(lp, { hostname: HOST, port: PORT }, async (_req) => {
  return new Response('Hello, World!', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
});

console.log(`Listening on http://${HOST}:${PORT}/`);
