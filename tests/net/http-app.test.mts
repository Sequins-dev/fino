/**
 * Tests for fino:net/http/app — middleware, routing, context, and OpenAPI.
 */

import { describe, it } from 'fino:test/test';
import { App, Router, body, cookies, defineMiddleware, defineProducer, errorHandler, memorySessionStore, schema, sessions } from 'fino:net/http/app';
import { Request, Response } from 'fino:net/http';
import { v } from 'fino:validate';

function request(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Request {
  return new Request(`http://example.test${path}`, {
    method: init.method ?? 'GET',
    headers: init.headers,
    body: init.body === undefined ? null : init.body,
  });
}

describe('HTTP app routing and middleware', () => {
  it('defaults direct handle() contexts to HTTP/1.1 protocol', async (t) => {
    const app = new App();
    app.get('/proto', (ctx) => Response.json({
      protocol: ctx.protocol,
      hasStream: ctx.stream !== undefined,
    }));

    const res = await app.handle(request('/proto'));
    t.deepEqual(await res.json(), { protocol: 'http/1.1', hasStream: false });
  });

  it('runs middleware in Koa order and exposes async request context', async (t) => {
    const app = new App();
    const order: string[] = [];

    app.use(async (ctx, next) => {
      order.push('root:before');
      t.equal(app.context(), ctx, 'active context visible before await');
      await next();
      t.equal(app.context(), ctx, 'active context visible after await');
      order.push('root:after');
    });

    app.route('/users/:id')
      .value('params', schema.params(v.object({ id: v.string() })))
      .value('user', async (ctx) => `user-${ctx.params.id}`)
      .get()
      .handle((ctx) => {
        order.push('handler');
        return Response.json({ id: ctx.params.id, user: ctx.user, empty: ctx.emptySlot });
      });

    const res = await app.handle(request('/users/42'));
    t.equal(res.status, 200);
    t.deepEqual(await res.json(), { id: '42', user: 'user-42' });
    t.deepEqual(order, ['root:before', 'handler', 'root:after']);
    t.equal(app.context(), undefined, 'context clears after request');
  });

  it('supports short-circuit middleware and empty declared slots', async (t) => {
    const app = new App()
      .value('emptySlot', async () => undefined)
      .use((_ctx, _next) => new Response('blocked', { status: 403 }));

    app.get('/never', () => new Response('never'));

    const res = await app.handle(request('/never'));
    t.equal(res.status, 403);
    t.equal(await res.text(), 'blocked');
  });

  it('mounts routers and keeps route method forks isolated', async (t) => {
    const router = new Router()
      .value('tenant', () => 'acme');

    router.route('/items/:id')
      .value('params', schema.params(v.object({ id: v.string() })))
      .get()
      .value('verbValue', () => 'read')
      .handle((ctx) => Response.json({ tenant: ctx.tenant, id: ctx.params.id, verb: ctx.verbValue, body: ctx.body }))
      .post()
      .value('body', body.json(v.object({ name: v.string() })))
      .handle((ctx) => Response.json({ tenant: ctx.tenant, id: ctx.params.id, name: ctx.body.name }));

    const app = new App().mount('/api', router);

    const getRes = await app.handle(request('/api/items/7'));
    t.deepEqual(await getRes.json(), { tenant: 'acme', id: '7', verb: 'read' });

    const postRes = await app.handle(request('/api/items/7', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":"desk"}',
    }));
    t.deepEqual(await postRes.json(), { tenant: 'acme', id: '7', name: 'desk' });
  });

  it('rejects duplicate context values and duplicate routes', (t) => {
    const app = new App().value('user', () => 'a');
    t.throws(() => app.value('user', () => 'b'), null, 'duplicate app value throws');

    app.get('/same', () => new Response('one'));
    t.throws(() => app.get('/same', () => new Response('two')), null, 'duplicate method/path throws');
  });
});

describe('HTTP app OpenAPI', () => {
  it('inherits route metadata and emits operation metadata from middleware', (t) => {
    const app = new App({ name: 'Example API' });
    app.route('/users/:id')
      .meta({ tags: ['users'] })
      .value('params', schema.params(v.object({ id: v.string() })))
      .get()
      .meta({ operationId: 'getUser', summary: 'Fetch a user' })
      .use(schema.query(v.object({ verbose: v.boolean().optional() })))
      .use(schema.response(v.object({ id: v.string() }), { status: 200, description: 'OK' }))
      .handle((ctx) => Response.json({ id: ctx.params.id }));

    const doc = app.openapi({ version: '1.0.0', servers: [{ url: 'https://api.example.test' }] }) as any;
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

  it('generates operation IDs and rejects duplicate OpenAPI metadata', (t) => {
    const app = new App();
    app.get('/users/:id', schema.response(v.object({ ok: v.boolean() })), () => Response.json({ ok: true }));
    const doc = app.openapi({ version: '1.0.0' }) as any;
    t.equal(doc.paths['/users/{id}'].get.operationId, 'getUsersById');

    const duplicate = new App();
    duplicate.get('/a', defineMiddleware((_ctx, next) => next(), { operationId: 'same' }), () => new Response('a'));
    duplicate.get('/b', defineMiddleware((_ctx, next) => next(), { operationId: 'same' }), () => new Response('b'));
    t.throws(() => duplicate.openapi({ version: '1.0.0' }), null, 'duplicate operation IDs throw');

    const bodies = new App();
    bodies.post('/body',
      defineProducer(async () => ({}), { requestBody: { content: { 'application/json': { schema: { type: 'object' } } } } }),
      defineProducer(async () => ({}), { requestBody: { content: { 'text/plain': { schema: { type: 'string' } } } } }),
      () => new Response('ok'),
    );
    t.throws(() => bodies.openapi({ version: '1.0.0' }), null, 'duplicate request bodies throw');
  });
});

describe('HTTP app built-ins', () => {
  it('parses body, mutates cookies, and persists memory sessions', async (t) => {
    const app = new App()
      .value('cookies', cookies())
      .value('session', sessions({ store: memorySessionStore(), cookie: 'sid' }));

    app.post('/login')
      .value('body', body.json(v.object({ user: v.string() })))
      .handle((ctx) => {
        ctx.session.data.user = ctx.body.user;
        ctx.cookies.set('theme', 'dark', { path: '/' });
        return Response.json({ user: ctx.session.data.user });
      });

    app.get('/me', (ctx) => Response.json({ user: ctx.session.data.user ?? null, theme: ctx.cookies.get('theme') ?? null }));

    const login = await app.handle(request('/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"user":"ada"}',
    }));
    t.deepEqual(await login.json(), { user: 'ada' });
    const setCookies = login.headers.getSetCookie();
    t.ok(setCookies.some((value) => value.startsWith('theme=dark')), 'theme cookie set');
    const sid = setCookies.find((value) => value.startsWith('sid='));
    t.ok(sid !== undefined, 'session cookie set');

    const me = await app.handle(request('/me', {
      headers: { cookie: `${sid!.split(';')[0]}; theme=dark` },
    }));
    t.deepEqual(await me.json(), { user: 'ada', theme: 'dark' });
  });

  it('serves OpenAPI over listen()', async (t) => {
    const app = new App({ name: 'Served API' });
    app.get('/openapi.json', app.openapiHandler({ version: '2.0.0' }));

    const server = app.listen({ port: 0, hostname: '127.0.0.1' });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/openapi.json`);
      const doc = await res.json() as any;
      t.equal(doc.info.title, 'Served API');
      t.equal(doc.info.version, '2.0.0');
    } finally {
      await server.close();
    }
  });

  it('converts errors with errorHandler', async (t) => {
    const app = new App()
      .use(errorHandler())
      .get('/boom', () => {
        throw new Error('boom');
      });

    const res = await app.handle(request('/boom'));
    t.equal(res.status, 500);
    t.deepEqual(await res.json(), { error: 'Internal Server Error' });
  });
});
