/**
 * Profiled HTTP server with a /stop route.
 *
 * Usage:
 *   PORT=3000 cargo run -- example_profile.mts
 *   autocannon -c 100 -d 10 http://127.0.0.1:$PORT/
 *   curl http://127.0.0.1:$PORT/stop   # stops profiling, writes profile.pb, shuts down
 */

import { serve } from 'fino:net/http/server';
import { Response } from 'fino:net/http';
import { startProfiling, stopProfiling } from 'fino:profiler';
import { DiskFileSystem } from 'fino:file';
import { env } from 'fino:process';

const HOST = '127.0.0.1';
const PORT = Number(env.PORT || '3000');

const fs = new DiskFileSystem();

startProfiling('http-server');
console.log('Profiling started.');

const server = serve({ hostname: HOST, port: PORT }, async (req) => {
  const url = new URL(req.url);

  if (url.pathname === '/stop') {
    const bytes = stopProfiling();
    console.log(`Profiling stopped. ${bytes.byteLength} bytes captured.`);
    await fs.writeFile('profile.pb', bytes);
    console.log('profile.pb written.');
    setTimeout(() => server.close(), 0);
    return new Response(`pprof profile written (${bytes.byteLength} bytes)\n`, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  }

  return new Response('Hello, World!', {
    status: 200,
    headers: { 'Content-Type': 'text/plain' },
  });
});

console.log(`Listening on http://${HOST}:${PORT}/`);
console.log(`Run: autocannon -c 100 -d 10 http://${HOST}:${PORT}/`);
console.log(`Then: curl http://${HOST}:${PORT}/stop`);
