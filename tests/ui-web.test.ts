import { describe, it } from 'fino:test/test';
import { memoryCache } from 'fino:cache';
import { App, cookies, sessions } from 'fino:net/http/app';
import { parseEventStream } from 'fino:net/http/eventstream';
import { h, Signal } from 'fino:ui';
import { page, view, webUI } from 'fino:ui/web';
import { InMemoryViewStore } from 'fino:ui/web/state';
async function collectEvents(response: Response) {
  const events: Array<{
    type: string;
    data: unknown;
    id: string | null;
  }> = [];
  for await (const event of parseEventStream(response.body!)) {
    events.push({
      type: event.type,
      data: JSON.parse(event.data),
      id: event.id,
    });
  }
  return events;
}
function makeApp() {
  const store = new InMemoryViewStore();
  const todos = view({
    id: 'todos',
    state: () => ({
      items: new Signal<string[]>([]),
      draft: new Signal(''),
    }),
    embed: ['draft'],
    actions: {
      add: {
        async handler({ state, checkpoint }, input) {
          state.items.set((items) => items.concat(String(input.text ?? '')));
          await checkpoint();
          state.draft.set('');
        },
      },
    },
    render({ state, actions }) {
      return h(
        'section',
        { id: 'todos' },
        h(
          'ul',
          { id: 'items' },
          state.items.get().map((item) => h('li', null, item)),
        ),
        h(
          'form',
          { action: actions.add },
          h('input', {
            name: 'text',
            value: state.draft.get(),
          }),
          h('button', null, 'Add'),
        ),
      );
    },
  });
  const app = new App();
  const ui = app
    .value('cookies', cookies())
    .value(
      'session',
      sessions({
        store: memoryCache({ namespace: 'sessions' }),
        keys: [
          {
            id: 'test',
            secret: 'ui-session-test-secret',
          },
        ],
        ttlMs: 6e4,
      }),
    )
    .layer(
      webUI({
        store,
        secret: 'test-secret',
      }),
    );
  ui.get('/').handle(page((ctx) => h('main', null, todos.mount(ctx))));
  ui.post('/').handle(page((ctx) => h('main', null, todos.mount(ctx))));
  return {
    app,
    store,
  };
}
function makeSecureApp() {
  const store = new InMemoryViewStore();
  let handlerRuns = 0;
  const secure = view({
    id: 'secure-view',
    state: () => ({
      items: new Signal<string[]>([]),
      token: new Signal('sealed-value'),
    }),
    embed: [
      {
        key: 'token',
        sealed: true,
      },
    ],
    actions: {
      add: {
        async handler({ state }) {
          handlerRuns++;
          state.items.set((items) => items.concat(String(state.token.get())));
        },
      },
    },
    render({ state, actions }) {
      return h(
        'section',
        { id: 'secure' },
        h(
          'ul',
          null,
          state.items.get().map((item) => h('li', null, item)),
        ),
        h('form', { action: actions.add }, h('button', null, 'Add')),
      );
    },
  });
  const app = new App();
  const ui = app
    .value('cookies', cookies())
    .value(
      'session',
      sessions({
        store: memoryCache({ namespace: 'sessions' }),
        keys: [
          {
            id: 'test',
            secret: 'ui-session-test-secret',
          },
        ],
        ttlMs: 6e4,
      }),
    )
    .layer(
      webUI({
        store,
        secret: 'test-secret',
      }),
    );
  ui.get('/secure').handle(page((ctx) => h('main', null, secure.mount(ctx))));
  ui.post('/secure').handle(page((ctx) => h('main', null, secure.mount(ctx))));
  return {
    app,
    runs: () => handlerRuns,
  };
}
function hidden(html: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = html.match(new RegExp(`name="${escaped}" value="([^"]*)"`));
  if (!match) throw new Error(`missing hidden input ${name}`);
  return match[1]!;
}
function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}
describe('fino:ui/web', () => {
  it('renders a page and applies an enhanced action as SSE patches', async (t) => {
    const { app, store } = makeApp();
    const first = (await app.handle(new Request('http://local/'))) as Response;
    const html = await first.text();
    const cookie = cookieHeader(first);
    t.ok(html.includes('<section id="todos"'), 'view renders into the page');
    t.ok(html.includes('data-fi-action'), 'form is annotated for enhancement');
    const body = new URLSearchParams({
      _view: hidden(html, '_view'),
      _ver: hidden(html, '_ver'),
      _nonce: hidden(html, '_nonce'),
      _csrf: hidden(html, '_csrf'),
      $draft: '',
      text: 'Write tests',
    });
    const action = (await app.handle(
      new Request('http://local/?_action=todos.add', {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'http://local',
          'sec-fetch-site': 'same-origin',
        },
        body: body.toString(),
      }),
    )) as Response;
    t.equal(action.headers.get('content-type')?.split(';')[0], 'text/event-stream');
    const events = await collectEvents(action);
    t.ok(
      events.some(
        (event) => event.type === 'patch' && JSON.stringify(event.data).includes('Write tests'),
      ),
      'action returns a patch with updated HTML',
    );
    t.equal(events.at(-1)?.type, 'close', 'action stream closes');
    t.equal(
      (await store.load(hidden(html, '_view')))?.version,
      2,
      'checkpoint and final state are both durable',
    );
  });
  it('uses PRG for no-JS actions and rejects invalid CSRF tokens', async (t) => {
    const { app } = makeApp();
    const first = (await app.handle(new Request('http://local/'))) as Response;
    const html = await first.text();
    const cookie = cookieHeader(first);
    const base = {
      _view: hidden(html, '_view'),
      _ver: hidden(html, '_ver'),
      _nonce: hidden(html, '_nonce'),
      _csrf: hidden(html, '_csrf'),
      $draft: '',
      text: 'Plain form',
    };
    const redirect = (await app.handle(
      new Request('http://local/?_action=todos.add', {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'http://local',
          'sec-fetch-site': 'same-origin',
        },
        body: new URLSearchParams(base).toString(),
      }),
    )) as Response;
    t.equal(redirect.status, 303, 'plain form action redirects');
    t.equal(redirect.headers.get('location'), '/', 'redirects to page URL');
    const rejected = (await app.handle(
      new Request('http://local/?_action=todos.add', {
        method: 'POST',
        headers: {
          cookie,
          accept: 'text/event-stream',
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'http://local',
          'sec-fetch-site': 'same-origin',
        },
        body: new URLSearchParams({
          ...base,
          _csrf: 'bad',
        }).toString(),
      }),
    )) as Response;
    t.equal(rejected.status, 403, 'bad csrf token is rejected');
  });
  it('rejects tampered sealed embedded state and ignores replayed nonces', async (t) => {
    const { app, runs } = makeSecureApp();
    const first = (await app.handle(new Request('http://local/secure'))) as Response;
    const html = await first.text();
    const cookie = cookieHeader(first);
    const base = {
      _view: hidden(html, '_view'),
      _ver: hidden(html, '_ver'),
      _nonce: hidden(html, '_nonce'),
      _csrf: hidden(html, '_csrf'),
      $token: hidden(html, '$token'),
    };
    const tampered = (await app.handle(
      new Request('http://local/secure?_action=secure-view.add', {
        method: 'POST',
        headers: {
          cookie,
          accept: 'text/event-stream',
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'http://local',
          'sec-fetch-site': 'same-origin',
        },
        body: new URLSearchParams({
          ...base,
          $token: 'bad',
        }).toString(),
      }),
    )) as Response;
    t.equal(tampered.status, 400, 'tampered sealed embed rejects');
    t.equal(runs(), 0, 'handler did not run for tampered embed');
    const ok = (await app.handle(
      new Request('http://local/secure?_action=secure-view.add', {
        method: 'POST',
        headers: {
          cookie,
          accept: 'text/event-stream',
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'http://local',
          'sec-fetch-site': 'same-origin',
        },
        body: new URLSearchParams(base).toString(),
      }),
    )) as Response;
    t.equal(ok.status, 200, 'first submit succeeds');
    t.equal(runs(), 1, 'handler ran once');
    const replay = (await app.handle(
      new Request('http://local/secure?_action=secure-view.add', {
        method: 'POST',
        headers: {
          cookie,
          accept: 'text/event-stream',
          'content-type': 'application/x-www-form-urlencoded',
          origin: 'http://local',
          'sec-fetch-site': 'same-origin',
        },
        body: new URLSearchParams(base).toString(),
      }),
    )) as Response;
    t.equal(replay.status, 200, 'replay short-circuits as a no-op stream');
    t.equal(runs(), 1, 'handler did not run twice');
  });
});
