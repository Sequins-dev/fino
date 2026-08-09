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
import 'fino:commands/code';
import 'fino:commands/code/tools';
import 'fino:commands/code/prompt';
import 'fino:commands/code/engine';
import 'fino:commands/code/tui';
import 'fino:commands/mcp';
import 'fino:ai/subagents';
import 'fino:tty';
import 'fino:tty/prompt';
import 'fino:realm';
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
import 'fino:data/dataset';
import 'fino:data/frame';
import 'fino:text/tokenizer';
import 'fino:model/hub';
import { DiskFileSystem } from 'fino:file';
const decodeUtf8 = (value: Uint8Array) => new TextDecoder().decode(value);
describe('builtin module layout', () => {
  it('exposes the pre-release public module grouping', async (t) => {
    t.ok(true, 'new public builtin grouping resolves');
  });
  it('exposes sessions only through the HTTP app surface', async (t) => {
    await t.rejects(
      () => import('fino:security/session'),
      /dynamic import failed|Cannot find module|not found|unknown/i,
    );
    const app = await import('fino:net/http/app');
    t.equal(typeof app.sessions, 'function');
    t.equal(typeof app.SessionConflictError, 'function');
  });
  it('keeps HTTP protocol drivers out of the public builtin API', async (t) => {
    await t.rejects(
      () => import('fino:net/http/h1'),
      /dynamic import failed|Cannot find module|not found|unknown/i,
    );
    await t.rejects(
      () => import('fino:net/http/h2'),
      /dynamic import failed|Cannot find module|not found|unknown/i,
    );
    await t.rejects(
      () => import('fino:net/http/h3'),
      /dynamic import failed|Cannot find module|not found|unknown/i,
    );
    await t.rejects(
      () => import('fino:net/http/driver'),
      /dynamic import failed|Cannot find module|not found|unknown/i,
    );
  });
  it('keeps HTTP globals and private protocol internals out of the public HTTP barrel', async (t) => {
    const http = await import('fino:net/http');
    t.deepEqual(Object.keys(http).sort(), [
      'App',
      'Arena',
      'BuilderBranch',
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
      'RouterBranch',
      'SessionConflictError',
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
      'parseRequest',
      'parseResponse',
      'schema',
      'serializeRequest',
      'serializeResponse',
      'serve',
      'serveHttp',
      'sessions',
      'staticFiles',
    ]);
  });
  it('splits QUIC class modules out of the public endpoint facade', async (t) => {
    const endpoint = await import('fino:net/quic/endpoint');
    const connection = await import('fino:net/quic/connection');
    const listener = await import('fino:net/quic/listener');
    const stream = await import('fino:net/quic/stream');
    const quic = await import('fino:net/quic');

    t.equal('QuicConnection' in endpoint, false, 'endpoint module omits QuicConnection');
    t.equal('QuicListener' in endpoint, false, 'endpoint module omits QuicListener');
    t.equal('QuicStream' in endpoint, false, 'endpoint module omits QuicStream');
    t.equal(typeof endpoint.QuicEndpoint, 'function', 'endpoint module keeps QuicEndpoint');
    t.equal(quic.QuicConnection, connection.QuicConnection, 'barrel reexports QuicConnection');
    t.equal(quic.QuicListener, listener.QuicListener, 'barrel reexports QuicListener');
    t.equal(quic.QuicStream, stream.QuicStream, 'barrel reexports QuicStream');
  });
  it('marks HTTP implementation source modules as internal for docs and type surfaces', async (t) => {
    const fs = new DiskFileSystem('/');
    for (const path of [
      'js/net/http/index.ts',
      'js/net/http/h1.ts',
      'js/net/http/driver.ts',
      'js/net/http/h2.ts',
      'js/net/http/h3.ts',
    ]) {
      const text = decodeUtf8(
        await fs.readFile(new URL(`../../${path}`, import.meta.url).pathname),
      );
      t.ok(text.slice(0, text.indexOf('*/') + 2).includes('@internal'), `${path} is @internal`);
    }
  });
  it('marks internal DNSSEC and HTTP/3 implementation modules as internal', async (t) => {
    const fs = new DiskFileSystem('/');
    for (const path of [
      'js/internal/encoding.ts',
      'js/internal/net/dnssec.ts',
      'js/internal/net/http/h3/bindings.ts',
      'js/internal/net/http/h3/body-queue.ts',
      'js/internal/net/http/h3/client.ts',
      'js/internal/net/http/h3/resolve.ts',
      'js/internal/net/http/h3/server.ts',
      'js/internal/net/http/h3/session.ts',
      'js/internal/net/http/h3/webtransport.ts',
    ]) {
      const text = decodeUtf8(
        await fs.readFile(new URL(`../../${path}`, import.meta.url).pathname),
      );
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
