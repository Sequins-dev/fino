/**
 * Hello World HTTP server — Node.js equivalent of example.mts.
 *
 * Run:   node example.node.mjs
 * Bench: autocannon -c 100 -d 10 http://127.0.0.1:3000/
 * Stop:  curl http://127.0.0.1:3000/stop
 */

import http from 'node:http';

const HOST = '127.0.0.1';
const PORT = 3000;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  if (url.pathname === '/stop') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('stopped\n');
    setTimeout(() => server.close(), 0);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello, World!');
});

server.listen(PORT, HOST, () => {
  console.log(`Listening on http://${HOST}:${PORT}/`);
  console.log('Stop:  curl http://127.0.0.1:3000/stop');
});
