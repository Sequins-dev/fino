import { describe, it } from 'fino:test/test';
import 'fino:format/markdown';
import 'fino:format/csv';
import 'fino:format/toml';
import 'fino:format/xml';
import 'fino:format/yaml';
import 'fino:format/typescript';
import 'fino:parsing/scanner';
import 'fino:compress';
import 'fino:database/sql';
import 'fino:database/migrate';
import 'fino:database/sqlite';
import 'fino:cache';
import 'fino:context';
import 'fino:context/topic';
import 'fino:process';
import 'fino:process/argv';
import 'fino:commands/root';
import 'fino:commands/run';
import 'fino:commands/test';
import 'fino:commands/bench';
import 'fino:commands/install';
import 'fino:commands/init';
import 'fino:commands/doc';
import 'fino:commands/fmt';
import 'fino:commands/lint';
import 'fino:commands/task';
import 'fino:commands/repl';
import 'fino:tty';
import 'fino:tty/prompt';
import 'fino:realm';
import 'fino:realm/pool';
import 'fino:realm/self';
import 'fino:realm/messaging';
import 'fino:module';
import 'fino:cluster';
import 'fino:net/http';
import 'fino:net/http/server';
import 'fino:net/http/client';
import 'fino:net/http/app';
import 'fino:net/http/eventstream';
import 'fino:net/http/eventsource';
import 'fino:net/http/websocket';
import 'fino:net/http/webtransport';
import 'fino:ai/cache';
import { DiskFileSystem } from 'fino:file';
describe('builtin module layout', () => {
  it('exposes the pre-release public module grouping', async (t) => {
    t.ok(true, 'new public builtin grouping resolves');
  });
  it('keeps HTTP protocol drivers out of the public builtin API', async (t) => {
    await t.rejects(() => import('fino:net/http/h1'), /dynamic import failed|Cannot find module|not found|unknown/i);
    await t.rejects(() => import('fino:net/http/h2'), /dynamic import failed|Cannot find module|not found|unknown/i);
    await t.rejects(() => import('fino:net/http/h3'), /dynamic import failed|Cannot find module|not found|unknown/i);
    await t.rejects(() => import('fino:net/http/driver'), /dynamic import failed|Cannot find module|not found|unknown/i);
  });
  it('keeps HTTP globals and private protocol internals out of the public HTTP barrel', async (t) => {
    const http = await import('fino:net/http');
    t.deepEqual(Object.keys(http).sort(), [
      'App',
      'CloseEvent',
      'CookieJar',
      'ErrorEvent',
      'EventSource',
      'HttpClient',
      'HttpResponse',
      'HttpSession',
      'MessageEvent',
      'MethodBuilder',
      'RouteBuilder',
      'Router',
      'RouterBase',
      'WebSocket',
      'WebSocketConnection',
      'WebSocketError',
      'WebTransport',
      'WebTransportDatagramDuplexStream',
      'body',
      'cookies',
      'defineMiddleware',
      'defineProducer',
      'errorHandler',
      'memorySessionStore',
      'parseRequest',
      'parseResponse',
      'schema',
      'serializeRequest',
      'serializeResponse',
      'serve',
      'serveHttp',
      'sessions',
      'staticFiles'
    ]);
  });
  it('marks HTTP implementation source modules as internal for docs and type surfaces', async (t) => {
    const fs = new DiskFileSystem('/');
    for (const path of [
      'js/net/http/index.ts',
      'js/net/http/h1.ts',
      'js/net/http/driver.ts',
      'js/net/http/h2.ts',
      'js/net/http/h3.ts'
    ]) {
      const text = await fs.readFile(new URL(`../../${path}`, import.meta.url).pathname);
      t.ok(text.slice(0, text.indexOf('*/') + 2).includes('@internal'), `${path} is @internal`);
    }
  });
  it('marks internal DNSSEC and HTTP/3 implementation modules as internal', async (t) => {
    const fs = new DiskFileSystem('/');
    for (const path of [
      'js/internal/net/dnssec.ts',
      'js/internal/net/http/h3/bindings.ts',
      'js/internal/net/http/h3/body-queue.ts',
      'js/internal/net/http/h3/client.ts',
      'js/internal/net/http/h3/resolve.ts',
      'js/internal/net/http/h3/server.ts',
      'js/internal/net/http/h3/session.ts',
      'js/internal/net/http/h3/webtransport.ts'
    ]) {
      const text = await fs.readFile(new URL(`../../${path}`, import.meta.url).pathname);
      t.ok(text.slice(0, text.indexOf('*/') + 2).includes('@internal'), `${path} is @internal`);
    }
  });
  it('keeps the public HTTP facade at js/net/http.ts', async (t) => {
    const fs = new DiskFileSystem('/');
    const rootFacade = new URL('../../js/net/http.ts', import.meta.url).pathname;
    const nestedFacade = new URL('../../js/net/http/public.ts', import.meta.url).pathname;
    await fs.stat(rootFacade);
    await t.rejects(() => fs.stat(nestedFacade), /No such file|ENOENT|not found/i);
  });
});
