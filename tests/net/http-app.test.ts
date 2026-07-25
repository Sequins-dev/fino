/**
* Tests for fino:net/http/app — middleware, routing, context, and OpenAPI.
*/
import { describe, it } from 'fino:test/test';
import { memoryCache } from 'fino:cache';
import { App, BuilderBranch, Router, RouteBuilder, body, cookies, defineMiddleware, defineProducer, errorHandler, schema, sessions } from 'fino:net/http/app';
import { WebSocketConnection, MessageEvent } from 'fino:net/http/websocket';
import { WebTransport } from 'fino:net/http/webtransport';
import { parseEventStream } from 'fino:net/http/eventstream';
import { v } from 'fino:validate';
import * as loop from 'internal:runtime/loop';
function request(path: string, init: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
} = {}): Request {
  return new Request(`http://example.test${path}`, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body === undefined ? null : init.body
  });
}
describe('HTTP app routing and middleware', () => {
  it('defaults direct handle() contexts to HTTP/1.1 protocol', async (t) => {
    const app = new App();
    app.get('/proto').handle((ctx) => Response.json({
      protocol: ctx.protocol,
      hasIncoming: ctx.incoming !== undefined
    }));
    const res = await app.handle(request('/proto'));
    t.deepEqual(await res.json(), {
      protocol: 'http/1.1',
      hasIncoming: false
    });
  });
  it('runs layers in Koa order and exposes async request context', async (t) => {
    const app = new App();
    const order: string[] = [];
    const branch = app.value('emptySlot', async () => undefined).layer(async (ctx, next) => {
      order.push('root:before');
      t.equal(app.context(), ctx, 'active context visible before await');
      await next();
      t.equal(app.context(), ctx, 'active context visible after await');
      order.push('root:after');
    });
    branch.route('/users/:id').value('params', schema.params(v.object({ id: v.string() }))).value('user', async (ctx) => `user-${ctx.params.id}`).get().handle((ctx) => {
      order.push('handler');
      return Response.json({
        id: ctx.params.id,
        user: ctx.user,
        empty: ctx.emptySlot
      });
    });
    const res = await app.handle(request('/users/42'));
    t.equal(res.status, 200);
    t.deepEqual(await res.json(), {
      id: '42',
      user: 'user-42'
    });
    t.deepEqual(order, [
      'root:before',
      'handler',
      'root:after'
    ]);
    t.equal(app.context(), undefined, 'context clears after request');
  });
  it('supports short-circuit middleware and empty declared slots', async (t) => {
    const app = new App();
    app.value('emptySlot', async () => undefined).use(() => new Response('blocked', { status: 403 })).get('/never').handle(() => new Response('never'));
    const res = await app.handle(request('/never'));
    t.equal(res.status, 403);
    t.equal(await res.text(), 'blocked');
  });
  it('treats enrichments as immutable tree nodes', async (t) => {
    const app = new App();
    const base = app.route('/branch');
    const enriched = base.value('flavor', () => 'enriched');
    t.ok(enriched !== base, 'value() returns a new builder');
    base.get().handle((ctx) => Response.json({ flavor: ctx.flavor ?? null }));
    const res = await app.handle(request('/branch'));
    t.deepEqual(await res.json(), { flavor: null }, 'sibling branch does not see the enrichment');
    t.ok(app.route('/other').use(async () => {}) instanceof RouteBuilder, 'use() returns a builder');
    t.ok(app.route('/shared') instanceof BuilderBranch, 'route builders share the exported base');
  });
  it('requires explicit immutable root branches for inherited enrichments', async (t) => {
    const app = new App();
    const early = app.value('seen', () => 'early');
    early.get('/early').handle((ctx) => Response.json({ seen: ctx.seen ?? null, late: ctx.late ?? null }));
    const late = early.value('late', () => 'late');
    late.get('/late').handle((ctx) => Response.json({ seen: ctx.seen ?? null, late: ctx.late ?? null }));
    app.get('/plain').handle((ctx) => Response.json({ seen: ctx.seen ?? null, late: ctx.late ?? null }));
    t.deepEqual(await (await app.handle(request('/early'))).json(), {
      seen: 'early',
      late: null
    }, 'explicit branch includes its inherited value');
    t.deepEqual(await (await app.handle(request('/late'))).json(), {
      seen: 'early',
      late: 'late'
    }, 'child branch includes both values');
    t.deepEqual(await (await app.handle(request('/plain'))).json(), {
      seen: null,
      late: null
    }, 'root routes do not inherit unchained branch values');
  });
  it('lets a later value shadow an earlier one along a branch', async (t) => {
    const app = new App();
    const base = app.value('who', () => 'app');
    base.get('/app').handle((ctx) => Response.json({ who: ctx.who }));
    base.route('/branch').value('who', () => 'branch').get().handle((ctx) => Response.json({ who: ctx.who }));
    t.deepEqual(await (await app.handle(request('/app'))).json(), { who: 'app' });
    t.deepEqual(await (await app.handle(request('/branch'))).json(), { who: 'branch' });
  });
  it('layers wrap downstream routes and unmatched fallback responses', async (t) => {
    const app = new App();
    const seen: string[] = [];
    const layered = app.layer(async (ctx, next) => {
      seen.push(`before:${ctx.route}`);
      const res = await next();
      seen.push(`after:${res instanceof Response ? res.status : 'upgrade'}`);
      if (res instanceof Response) res.headers.set('x-layered', 'yes');
      return res;
    });
    layered.get('/hit').handle(() => new Response('hit'));
    const hit = await app.handle(request('/hit'));
    t.equal(await hit.text(), 'hit');
    t.equal(hit.headers.get('x-layered'), 'yes');
    const miss = await app.handle(request('/miss'));
    t.equal(miss.status, 404);
    t.equal(miss.headers.get('x-layered'), 'yes');
    t.deepEqual(seen, [
      'before:/hit',
      'after:200',
      'before:/miss',
      'after:404'
    ]);
  });
  it('route-scoped layers only run when their path branch matches', async (t) => {
    const app = new App();
    const seen: string[] = [];
    app.route('/admin').layer(async (_ctx, next) => {
      seen.push('admin');
      return next();
    }).get().handle(() => new Response('admin'));
    app.get('/public').handle(() => new Response('public'));
    t.equal(await (await app.handle(request('/admin'))).text(), 'admin');
    t.equal(await (await app.handle(request('/public'))).text(), 'public');
    t.equal((await app.handle(request('/admin', { method: 'POST' }))).status, 405);
    t.equal((await app.handle(request('/other'))).status, 404);
    t.deepEqual(seen, ['admin', 'admin']);
  });
  it('nests route builders for grouped REST routes', async (t) => {
    const app = new App();
    const users = app.route('/users').value('db', () => 'db-handle');
    users.get().handle((ctx) => Response.json({ scope: 'list', db: ctx.db }));
    const user = users.route('/:id').value('params', schema.params(v.object({ id: v.string() })));
    user.get().handle((ctx) => Response.json({
      scope: 'show',
      id: ctx.params.id,
      db: ctx.db
    }));
    user.delete().handle(() => new Response(null, { status: 204 }));
    t.deepEqual(await (await app.handle(request('/users'))).json(), {
      scope: 'list',
      db: 'db-handle'
    });
    t.deepEqual(await (await app.handle(request('/users/7'))).json(), {
      scope: 'show',
      id: '7',
      db: 'db-handle'
    });
    t.equal((await app.handle(request('/users/7', { method: 'DELETE' }))).status, 204);
  });
  it('mounts routers and keeps route method forks isolated', async (t) => {
    const router = new Router();
    const tenantRouter = router.value('tenant', () => 'acme');
    tenantRouter.route('/items/:id').value('params', schema.params(v.object({ id: v.string() }))).get().value('verbValue', () => 'read').handle((ctx) => Response.json({
      tenant: ctx.tenant,
      id: ctx.params.id,
      verb: ctx.verbValue,
      body: ctx.body
    })).post().value('body', body.json(v.object({ name: v.string() }))).handle((ctx) => Response.json({
      tenant: ctx.tenant,
      id: ctx.params.id,
      name: ctx.body.name
    }));
    const app = new App();
    app.route('/api').mount(router);
    const getRes = await app.handle(request('/api/items/7'));
    t.deepEqual(await getRes.json(), {
      tenant: 'acme',
      id: '7',
      verb: 'read'
    });
    const postRes = await app.handle(request('/api/items/7', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"desk"}'
    }));
    t.deepEqual(await postRes.json(), {
      tenant: 'acme',
      id: '7',
      name: 'desk'
    });
  });
  it('rejects changes to a mounted router', (t) => {
    const router = new Router();
    router.get('/a').handle(() => new Response('a'));
    const app = new App();
    app.route('/api').mount(router);
    t.throws(() => router.get('/b'), /already mounted/, 'registering after mount throws');
    t.throws(() => router.use(async () => undefined), /already mounted/, 'use after mount throws');
    const again = new App();
    t.throws(() => again.route('/v2').mount(router), /already mounted/, 'mounting twice throws');
  });
  it('mounts nested routers with params from all levels', async (t) => {
    const inner = new Router();
    inner.route('/:item').get().handle((ctx) => Response.json(ctx.params));
    const outer = new Router();
    outer.route('/:box').mount(inner);
    const app = new App();
    app.route('/warehouses/:warehouse').mount(outer);
    const res = await app.handle(request('/warehouses/w1/b2/i3'));
    t.deepEqual(await res.json(), {
      warehouse: 'w1',
      box: 'b2',
      item: 'i3'
    });
  });
  it('runs branch middleware before mounted routes', async (t) => {
    const order: string[] = [];
    const router = new Router();
    router.get('/child').handle(() => {
      order.push('handler');
      return new Response('ok');
    });
    const app = new App();
    app.route('/x').use(async () => {
      order.push('branch');
    }).mount(router);
    await app.handle(request('/x/child'));
    t.deepEqual(order, ['branch', 'handler']);
  });
  it('rejects duplicate operations and stale inline handlers', (t) => {
    const app = new App();
    app.get('/same').handle(() => new Response('one'));
    t.throws(() => app.get('/same').handle(() => new Response('two')), /Duplicate route GET \/same/, 'duplicate method/path throws');
    t.throws(() => (app.get as (path: string, extra: unknown) => unknown)('/old', () => new Response('x')), /register the handler with .handle\(\)/, 'inline handlers are rejected loudly');
  });
  it('returns 405 with Allow for matched paths and 426 for upgrade-only paths', async (t) => {
    const app = new App();
    app.get('/thing').handle(() => new Response('get'));
    app.route('/thing').post().handle(() => new Response('post'));
    const miss = await app.handle(request('/thing', { method: 'DELETE' }));
    t.equal(miss.status, 405);
    t.equal(miss.headers.get('allow'), 'GET, POST', '405 lists allowed methods');
    app.route('/socket-only').websocket(async () => {});
    const upgrade = await app.handle(request('/socket-only'));
    t.equal(upgrade.status, 426);
    t.equal(upgrade.headers.get('upgrade'), 'websocket', '426 names the upgrade protocol');
  });
});
describe('HTTP app OpenAPI', () => {
  it('inherits route metadata and emits operation metadata from middleware', (t) => {
    const app = new App({ name: 'Example API' });
    app.route('/users/:id').meta({ tags: ['users'] }).value('params', schema.params(v.object({ id: v.string() }))).get().meta({
      operationId: 'getUser',
      summary: 'Fetch a user'
    }).use(schema.query(v.object({ verbose: v.boolean().optional() }))).layer(schema.response(v.object({ id: v.string() }), {
      status: 200,
      description: 'OK'
    })).handle((ctx) => Response.json({ id: ctx.params.id }));
    const doc = app.openapi({
      version: '1.0.0',
      servers: [{ url: 'https://api.example.test' }]
    }) as any;
    const op = doc.paths['/users/{id}'].get;
    t.equal(doc.openapi, '3.1.0');
    t.equal(doc.info.title, 'Example API');
    t.equal(op.operationId, 'getUser');
    t.deepEqual(op.tags, ['users']);
    t.equal(op.summary, 'Fetch a user');
    t.equal(op.parameters[0].name, 'id');
    t.equal(op.parameters[0].in, 'path');
    t.equal(op.parameters[1].name, 'verbose');
    t.equal(op.responses['200'].description, 'OK');
    t.deepEqual(doc.servers, [{ url: 'https://api.example.test' }]);
  });
  it('generates operation IDs and applies last-wins metadata', (t) => {
    const app = new App();
    app.get('/users/:id').layer(schema.response(v.object({ ok: v.boolean() }))).handle(() => Response.json({ ok: true }));
    const doc = app.openapi({ version: '1.0.0' }) as any;
    t.equal(doc.paths['/users/{id}'].get.operationId, 'getUsersById');
    const duplicate = new App();
    duplicate.get('/a').use(defineMiddleware(() => undefined, { operationId: 'same' })).handle(() => new Response('a'));
    duplicate.get('/b').use(defineMiddleware(() => undefined, { operationId: 'same' })).handle(() => new Response('b'));
    t.throws(() => duplicate.openapi({ version: '1.0.0' }), /Duplicate OpenAPI operationId/, 'duplicate operation IDs throw');
    const bodies = new App();
    bodies.post('/body').value('first', defineProducer(async () => ({}), { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } })).value('second', defineProducer(async () => ({}), { requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } } })).handle(() => new Response('ok'));
    const bodyDoc = bodies.openapi({ version: '1.0.0' }) as any;
    t.deepEqual(Object.keys(bodyDoc.paths['/body'].post.requestBody.content), ['text/plain'], 'later request body wins');
  });
  it('documents sse operations and mounted routes', (t) => {
    const router = new Router();
    router.get('/stats').handle(() => Response.json({}));
    const app = new App();
    app.route('/events').sse(async () => {});
    app.route('/admin').mount(router);
    const doc = app.openapi({ version: '1.0.0' }) as any;
    t.equal(doc.paths['/events'].get.responses['200'].description, 'Server-sent event stream');
    t.ok(doc.paths['/events'].get.responses['200'].content['text/event-stream'] !== undefined, 'sse documents an event-stream response');
    t.ok(doc.paths['/events'].post !== undefined, 'sse documents the POST operation');
    t.ok(doc.paths['/admin/stats'].get !== undefined, 'mounted routes appear in the document');
  });
});
describe('HTTP app built-ins', () => {
  it('parses body, mutates cookies, and persists memory sessions', async (t) => {
    const app = new App();
    const stateful = app.value('cookies', cookies()).value('session', sessions({
      store: memoryCache({ namespace: 'sessions' }),
      keys: [{ id: 'test', secret: 'http-app-session-test-secret' }],
      ttlMs: 60_000,
      cookie: 'sid'
    }));
    stateful.post('/login').value('body', body.json(v.object({ user: v.string() }))).handle((ctx) => {
      ctx.session.data.user = ctx.body.user;
      ctx.cookies.set('theme', 'dark', { path: '/' });
      return Response.json({ user: ctx.session.data.user });
    });
    stateful.get('/me').handle((ctx) => Response.json({
      user: ctx.session.data.user ?? null,
      theme: ctx.cookies.get('theme') ?? null
    }));
    const login = await app.handle(request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"user":"ada"}'
    }));
    t.deepEqual(await login.json(), { user: 'ada' });
    const setCookies = login.headers.getSetCookie();
    t.ok(setCookies.some((value) => value.startsWith('theme=dark')), 'theme cookie set');
    const sid = setCookies.find((value) => value.startsWith('sid='));
    t.ok(sid !== undefined, 'session cookie set');
    const me = await app.handle(request('/me', { headers: { cookie: `${sid!.split(';')[0]}; theme=dark` } }));
    t.deepEqual(await me.json(), {
      user: 'ada',
      theme: 'dark'
    });
  });
  it('serves OpenAPI over listen()', async (t) => {
    const app = new App({ name: 'Served API' });
    app.get('/openapi.json').handle(app.openapiHandler({ version: '2.0.0' }));
    const server = app.listen({
      port: 0,
      hostname: '127.0.0.1'
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/openapi.json`);
      const doc = await res.json() as any;
      t.equal(doc.info.title, 'Served API');
      t.equal(doc.info.version, '2.0.0');
    } finally {
      await server.close();
    }
  });
  it('accepts websocket routes over listen()', async (t) => {
    const app = new App();
    app.route('/chat').websocket(async (socket, ctx) => {
      t.equal(ctx.incoming.kind, 'websocket', 'websocket context exposes incoming');
      socket.addEventListener('message', (event) => {
        void socket.send(`echo:${(event as MessageEvent).data}`);
      });
    });
    const server = app.listen({
      port: 0,
      hostname: '127.0.0.1'
    });
    try {
      const client = WebSocketConnection.connect(`ws://127.0.0.1:${server.port}/chat`);
      const opened = new Promise<void>((resolve) => client.addEventListener('open', () => resolve(), { once: true }));
      await opened;
      const message = new Promise<MessageEvent>((resolve, reject) => {
        const timer = loop.timeout(1e3);
        timer.then(() => reject(new Error('timed out waiting for websocket echo'))).catch(() => {});
        client.addEventListener('message', (event) => {
          timer.cancel();
          resolve(event as MessageEvent);
        }, { once: true });
      });
      await client.send('hello');
      t.equal((await message).data, 'echo:hello', 'websocket route echoes messages');
      await client.close();
      const invalid = await fetch(`http://127.0.0.1:${server.port}/chat`, { headers: { upgrade: 'websocket' } as any });
      t.equal(invalid.status, 426, 'incomplete websocket handshake gets 426');
      const plain = await fetch(`http://127.0.0.1:${server.port}/chat`);
      t.equal(plain.status, 426, 'plain http on a websocket-only route gets 426');
    } finally {
      await server.close();
    }
  });
  it('runs middleware for websocket routes and rejects with responses', async (t) => {
    const order: string[] = [];
    const app = new App();
    app.route('/guarded').use(async (ctx) => {
      order.push('guard');
      if (ctx.request.headers.get('x-key') !== 'secret') {
        return Response.json({ error: 'Forbidden' }, { status: 403 });
      }
    }).websocket(async () => {
      order.push('handler');
    });
    const rejected: Response[] = [];
    let accepted = 0;
    const incoming = (key: string | null) => ({
      kind: 'websocket',
      request: request('/guarded', key === null ? {} : { headers: { 'x-key': key } }),
      protocol: 'http/1.1',
      session: {
        id: 'ws-test',
        protocol: 'http/1.1',
        transport: 'tcp',
        secure: false,
        localAddress: null,
        remoteAddress: null,
        closed: Promise.resolve()
      },
      reject(res?: Response) {
        if (res !== undefined) rejected.push(res);
        return Promise.resolve();
      },
      accept() {
        accepted += 1;
        return Promise.resolve(new EventTarget() as unknown);
      }
    }) as any;
    await (app as any)._handleWebTransportForTest(incoming(null));
    t.equal(accepted, 0, 'short-circuited upgrade is never accepted');
    t.equal(rejected.length, 1, 'upgrade rejected with the middleware response');
    t.equal(rejected[0]!.status, 403);
    t.deepEqual(order, ['guard'], 'handler never ran');
    await (app as any)._handleWebTransportForTest(incoming('secret'));
    t.equal(accepted, 1, 'passing middleware accepts the upgrade');
    t.deepEqual(order, [
      'guard',
      'guard',
      'handler'
    ]);
  });
  it('streams sse routes through handle() for GET and POST', async (t) => {
    const app = new App();
    app.route('/events').sse(async (events, ctx) => {
      await events.write({ data: `method:${ctx.method}` });
      await events.write({ event: 'done', data: '{}', id: '1' });
    });
    const res = await app.handle(request('/events')) as Response;
    t.equal(res.headers.get('content-type'), 'text/event-stream', 'sse route sets event-stream content type');
    const received: Array<{ type: string; data: string; id: string | null }> = [];
    for await (const event of parseEventStream(res.body!)) {
      received.push({ type: event.type, data: event.data, id: event.id });
    }
    t.deepEqual(received, [
      { type: 'message', data: 'method:GET', id: null },
      { type: 'done', data: '{}', id: '1' }
    ], 'handler events arrive parsed in order');
    const post = await app.handle(request('/events', { method: 'POST', body: 'x' })) as Response;
    const first = await parseEventStream(post.body!).read();
    t.equal(first?.data, 'method:POST', 'sse route also matches POST');
    const put = await app.handle(request('/events', { method: 'PUT', body: 'x' })) as Response;
    t.equal(put.status, 405, 'sse route rejects other methods');
    t.equal(put.headers.get('allow'), 'GET, POST');
  });
  it('terminates sse streams when the handler throws', async (t) => {
    const app = new App();
    app.route('/broken').sse(async (events) => {
      await events.write({ data: 'first' });
      throw new Error('boom');
    });
    const res = await app.handle(request('/broken')) as Response;
    const reader = parseEventStream(res.body!);
    t.equal((await reader.read())?.data, 'first', 'events before the failure are delivered');
    await t.rejects(async () => {
      await reader.read();
    }, /boom/, 'the stream fails with the handler error');
  });
  it('serves sse routes over listen()', async (t) => {
    const app = new App();
    app.route('/ticks').sse(async (events) => {
      await events.write({ data: 'tick' });
      await events.write({ event: 'done', data: 'bye' });
    });
    const server = app.listen({
      port: 0,
      hostname: '127.0.0.1'
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/ticks`);
      t.equal(res.headers.get('content-type'), 'text/event-stream');
      const events: string[] = [];
      for await (const event of parseEventStream(res.body!)) {
        events.push(`${event.type}:${event.data}`);
      }
      t.deepEqual(events, ['message:tick', 'done:bye'], 'sse events stream over a real server');
    } finally {
      await server.close();
    }
  });
  it('flushes an sse event before a long-lived handler completes', async (t) => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const app = new App();
    app.route('/live').sse(async (events) => {
      await events.write({ data: 'connected' });
      await hold;
    });
    const server = app.listen({
      port: 0,
      hostname: '127.0.0.1'
    });
    try {
      const response = await Promise.race([fetch(`http://127.0.0.1:${server.port}/live`), loop.timeout(1e3).then(() => {
        throw new Error('sse response headers timed out');
      })]);
      const event = await Promise.race([parseEventStream(response.body!).read(), loop.timeout(1e3).then(() => {
        throw new Error('initial sse event timed out');
      })]);
      t.equal(event?.data, 'connected', 'the initial event arrives while the handler remains active');
    } finally {
      release();
      await server.close();
    }
  });
  it('mounts routers carrying protocol operations', async (t) => {
    const router = new Router();
    router.route('/jobs/:queue').sse(async (events, ctx) => {
      await events.write({ data: `queue:${ctx.params?.queue}` });
    });
    const app = new App();
    app.route('/admin').mount(router);
    const res = await app.handle(request('/admin/jobs/mail')) as Response;
    t.equal(res.headers.get('content-type'), 'text/event-stream');
    const first = await parseEventStream(res.body!).read();
    t.equal(first?.data, 'queue:mail', 'mounted sse route streams with prefix params');
  });
  it('registers webtransport routes with inherited context values', async (t) => {
    const app = new App();
    let sawContext = false;
    app.value('tenant', () => 'acme').route('/wt/:room').webtransport(async (session, ctx) => {
      sawContext = session instanceof WebTransport && ctx.method === 'WEBTRANSPORT' && ctx.params?.room === 'lobby' && ctx.tenant === 'acme';
    });
    const incoming = {
      kind: 'webtransport',
      request: request('/wt/lobby'),
      protocol: 'h3',
      session: {
        id: 'test-session',
        protocol: 'h3',
        transport: 'quic',
        secure: true,
        localAddress: null,
        remoteAddress: null,
        closed: Promise.resolve()
      },
      reject() {
        throw new Error('unexpected reject');
      },
      accept() {
        return Promise.resolve(WebTransport.unavailable('https://local.test/wt/lobby', 'test'));
      }
    } as any;
    await (app as any)._handleWebTransportForTest(incoming);
    t.equal(sawContext, true);
  });
  it('dispatches rpc services as POST and 405s other methods', async (t) => {
    const app = new App();
    app.route('/rpc').rpc({
      httpHandler: () => async (req: Request) => Response.json({ echoed: await req.text() })
    });
    const posted = await app.handle(request('/rpc', { method: 'POST', body: 'ping' }));
    t.deepEqual(await posted.json(), { echoed: 'ping' });
    const got = await app.handle(request('/rpc'));
    t.equal(got.status, 405, 'non-POST on an rpc route is 405');
    t.equal(got.headers.get('allow'), 'POST');
  });
  it('converts errors with errorHandler', async (t) => {
    const app = new App();
    app.layer(errorHandler()).get('/boom').handle(() => {
      throw new Error('boom');
    });
    const res = await app.handle(request('/boom'));
    t.equal(res.status, 500);
    t.deepEqual(await res.json(), { error: 'Internal Server Error' });
  });
});
