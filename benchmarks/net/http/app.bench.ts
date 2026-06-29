/**
* Benchmarks for fino:net/http/app
*
* Run with: cargo run -- bench benchmarks/net/http/app.bench.ts
*/
import { App, body, schema } from 'fino:net/http/app';
import { v } from 'fino:validate';
import { bench } from 'fino:bench';
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
function createRoutingApp(): App {
  const app = new App({ name: 'Bench API' });
  app.use(async (ctx, next) => {
    const res = await next();
    res.headers.set('x-route', ctx.route);
    return res;
  });
  app.route('/users/:id').value('params', schema.params(v.object({ id: v.string() }))).get().handle((ctx) => Response.json({ id: ctx.params.id }));
  app.route('/items/:id').value('params', schema.params(v.object({ id: v.string() }))).post().value('body', body.json(v.object({ name: v.string() }))).handle((ctx) => Response.json({
    id: ctx.params.id,
    name: ctx.body.name
  }));
  return app;
}
bench('net/http/app routing', (b) => {
  const app = createRoutingApp();
  b.measure('GET route dispatch', () => app.handle(request('/users/42')));
  b.measure('POST json route dispatch', () => app.handle(request('/items/7', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"name":"desk"}'
  })));
  b.measure('404 dispatch', () => app.handle(request('/missing')));
});
bench('net/http/app OpenAPI', (b) => {
  const app = createRoutingApp();
  b.measure('generate OpenAPI document', () => app.openapi({ version: '1.0.0' }));
});
