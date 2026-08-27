import { memoryStore } from 'fino:store';
import { App, cookies, sessions } from 'fino:net/http/app';
import { parseEventStream } from 'fino:net/http/eventstream';
import { h, Signal } from 'fino:ui';
import {
  page,
  view,
  webUI,
  type PortableActionRef,
  type PortableRenderEvent,
  type PortableUIEvent,
  type PortableValue,
} from 'fino:ui/web';
import { deleteViewState, loadViewState } from 'fino:ui/web/state';
import type { Assert } from 'fino:test/assert';
import { describe, it } from 'fino:test/test';

const eventStreamAccept = 'text/event-stream';

function makeApp(options: { maxActionBytes?: number } = {}) {
  const store = memoryStore();
  const counter = view({
    id: 'portable-counter',
    state: () => ({ count: new Signal(0) }),
    actions: {
      increment: {
        input: {
          type: 'object',
          properties: {
            amount: { type: 'number' },
          },
          required: ['amount'],
          additionalProperties: false,
        },
        handler({ state }, input) {
          if (input.amount === 13) throw new Error('sensitive handler details');
          state.count.set((value) => value + Number(input.amount));
        },
      },
    },
    render({ state, actions }) {
      return h('app.counter.v1', {
        key: 'counter',
        count: state.count.get(),
        increment: actions.increment,
      });
    },
  });
  const app = new App();
  const ui = app
    .value('cookies', cookies())
    .value(
      'session',
      sessions({
        store: memoryStore({ namespace: 'portable-ui-sessions' }),
        keys: [{ id: 'test', secret: 'portable-ui-session-secret' }],
        ttlMs: 6e4,
      }),
    )
    .layer(webUI({ store, secret: 'portable-ui-secret', ...options }));
  ui.get('/').handle(page((ctx) => counter.mount(ctx)));
  return { app, store };
}

async function collectEvents(response: Response) {
  const events: Array<{
    type: string;
    id: string;
    data: PortableUIEvent & Record<string, any>;
  }> = [];
  for await (const event of parseEventStream(response.body!)) {
    events.push({
      type: event.type,
      id: event.id,
      data: JSON.parse(event.data) as PortableUIEvent & Record<string, any>,
    });
  }
  return events;
}

async function firstEvent(response: Response) {
  const iterator = parseEventStream(response.body!)[Symbol.asyncIterator]();
  const event = await iterator.next();
  await iterator.return?.();
  if (event.done || event.value === undefined) throw new Error('Expected an SSE event');
  return {
    type: event.value.type,
    id: event.value.id,
    data: JSON.parse(event.value.data) as PortableUIEvent & Record<string, any>,
  };
}

function cookieHeader(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
}

async function mountPortable(app: App) {
  const response = (await app.handle(
    new Request('http://local/', {
      headers: { accept: eventStreamAccept },
    }),
  )) as Response;
  const render = await firstEvent(response);
  if (render?.data.kind !== 'render') throw new Error('Expected portable render event');
  return {
    response,
    cookie: cookieHeader(response),
    render,
    action: render.data.tree.props.increment as unknown as PortableActionRef,
  };
}

function postAction(
  app: App,
  action: PortableActionRef,
  cookie: string | undefined,
  input: Record<string, PortableValue>,
  overrides: Record<string, unknown> = {},
): Promise<Response | undefined> {
  const headers = new Headers({
    'content-type': 'application/json',
  });
  if (cookie !== undefined) headers.set('cookie', cookie);
  return app.handle(
    new Request(`http://local${action.url}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        version: 1,
        view: action.view,
        revision: action.revision,
        request: action.request,
        input,
        ...overrides,
      }),
    }),
  );
}

async function expectPortableError(
  t: Assert,
  response: Response,
  status: number,
  code: string,
  recoverable: boolean,
): Promise<void> {
  t.equal(response.status, status);
  t.equal(response.headers.get('content-type'), 'text/event-stream');
  const events = await collectEvents(response);
  t.deepEqual(events[0]?.data, {
    version: 1,
    kind: 'error',
    code,
    recoverable,
  });
  t.deepEqual(events[1]?.data, { version: 1, kind: 'close' });
}

describe('JSON server-driven UI', () => {
  it('keeps CSRF tokens and the sealing secret out of the rendered tree', async (t) => {
    const { app } = makeApp();
    const { render } = await mountPortable(app);
    const serialized = JSON.stringify(render.data);
    t.equal(
      serialized.includes('portable-ui-secret'),
      false,
      'the sealing secret never reaches a rendered tree',
    );
    t.equal(serialized.includes('csrf'), false, 'no CSRF material is serialized into props');
    const action = (render.data as PortableRenderEvent).tree.props
      .increment as unknown as PortableActionRef;
    t.deepEqual(
      Object.keys(action).sort(),
      ['action', 'request', 'revision', 'url', 'view'],
      'an action descriptor carries only its public fields',
    );

    const html = (await app.handle(new Request('http://local/'))) as Response;
    const body = await html.text();
    t.equal(
      body.includes('portable-ui-secret'),
      false,
      'the sealing secret never reaches rendered HTML either',
    );
  });

  it('uses the JSON protocol for an ordinary EventSource request', async (t) => {
    const { app } = makeApp();
    const response = (await app.handle(
      new Request('http://local/', {
        headers: { accept: 'text/event-stream' },
      }),
    )) as Response;

    t.equal(response.headers.get('content-type'), 'text/event-stream');
    const event = await firstEvent(response);
    t.equal(event.type, 'ui');
    t.equal(event.data.kind, 'render');
  });

  it('starts a route stream with the current versioned semantic tree', async (t) => {
    const { app } = makeApp();
    const { response, render } = await mountPortable(app);

    t.equal(response.headers.get('content-type'), 'text/event-stream');
    t.equal(render.type, 'ui');
    t.equal(render.id, '0');
    t.deepEqual(render.data, {
      version: 1,
      kind: 'render',
      view: 'portable-counter',
      revision: 0,
      tree: {
        type: 'app.counter.v1',
        props: {
          count: 0,
          increment: {
            action: 'increment',
            url: '/?_action=portable-counter.increment',
            view: render.data.viewId,
            revision: 0,
            request: render.data.tree.props.increment.request,
          },
        },
        children: [],
        key: 'counter',
      },
      viewId: render.data.viewId,
    });
  });

  it('runs authenticated JSON actions through the same SSE execution loop', async (t) => {
    const { app, store } = makeApp();
    const { cookie, action } = await mountPortable(app);
    const response = (await postAction(app, action, cookie, { amount: 2 })) as Response;

    t.equal(response.headers.get('content-type'), 'text/event-stream');
    const events = await collectEvents(response);
    t.equal(events[0]?.type, 'ui');
    t.equal(events[0]?.id, '1');
    t.equal(events[0]?.data.kind, 'render');
    t.equal(events[0]?.data.tree.props.count, 2);
    t.deepEqual(events[1]?.data, { version: 1, kind: 'close' });
    t.equal((await loadViewState(store, action.view))?.version, 1);
  });

  it('returns a safe SSE error before invalid input reaches an action', async (t) => {
    const { app } = makeApp();
    const { cookie, action } = await mountPortable(app);
    const response = (await postAction(app, action, cookie, {
      amount: 'not-a-number',
    })) as Response;

    await expectPortableError(t, response, 400, 'invalid_input', true);
  });

  it('starts live reconnects with a render or navigation snapshot', async (t) => {
    const { app, store } = makeApp();
    const { cookie, action } = await mountPortable(app);
    await postAction(app, action, cookie, { amount: 2 });

    const live = (await app.handle(
      new Request(`http://local/_fino/live?view=${action.view}`, {
        headers: {
          accept: eventStreamAccept,
          cookie,
          'last-event-id': '0',
        },
      }),
    )) as Response;
    const iterator = parseEventStream(live.body!)[Symbol.asyncIterator]();
    const render = await iterator.next();
    t.equal(render.value?.type, 'ui');
    t.equal(render.value?.id, '1');
    const renderData = JSON.parse(render.value!.data);
    t.equal(renderData.tree.props.count, 2);
    t.equal(renderData.tree.props.increment.url, '/?_action=portable-counter.increment');
    await iterator.return?.();

    const current = (await app.handle(
      new Request(`http://local/_fino/live?view=${action.view}`, {
        headers: {
          accept: eventStreamAccept,
          cookie,
          'last-event-id': '1',
        },
      }),
    )) as Response;
    const currentEvent = await firstEvent(current);
    t.equal(currentEvent.data.kind, 'render');
    t.equal(currentEvent.data.revision, 1);

    await deleteViewState(store, action.view);
    const expired = (await app.handle(
      new Request(`http://local/_fino/live?view=${action.view}`, {
        headers: {
          accept: eventStreamAccept,
          cookie,
          'last-event-id': '1',
        },
      }),
    )) as Response;
    const expiredIterator = parseEventStream(expired.body!)[Symbol.asyncIterator]();
    const navigate = await expiredIterator.next();
    t.equal(navigate.value?.type, 'ui');
    t.deepEqual(JSON.parse(navigate.value!.data), {
      version: 1,
      kind: 'navigate',
      url: '/',
      replace: true,
    });
    await expiredIterator.return?.();
  });

  it('does not negotiate variants through Accept parameters', async (t) => {
    const { app } = makeApp();
    const response = (await app.handle(
      new Request('http://local/', {
        headers: { accept: 'text/event-stream; profile=custom' },
      }),
    )) as Response;

    t.equal(response.status, 200);
    const event = await firstEvent(response);
    t.equal(event.data.kind, 'render');
  });

  it('keeps the route stream subscribed after its initial snapshot', async (t) => {
    const { app } = makeApp();
    const response = (await app.handle(
      new Request('http://local/', {
        headers: { accept: eventStreamAccept },
      }),
    )) as Response;
    const cookie = cookieHeader(response);
    const iterator = parseEventStream(response.body!)[Symbol.asyncIterator]();
    const initial = await iterator.next();
    const initialData = JSON.parse(initial.value!.data) as PortableRenderEvent;
    const action = initialData.tree.props.increment as unknown as PortableActionRef;

    const actionResponse = (await postAction(app, action, cookie, { amount: 3 })) as Response;
    await collectEvents(actionResponse);
    const update = await iterator.next();
    const updateData = JSON.parse(update.value!.data) as PortableRenderEvent;

    t.equal(update.value?.type, 'ui');
    t.equal(updateData.kind, 'render');
    t.equal(updateData.revision, 1);
    t.equal(updateData.tree.props.count, 3);
    await iterator.return?.();
  });

  it('rejects a mismatched action protocol before dispatch', async (t) => {
    const { app } = makeApp();
    const { cookie, action } = await mountPortable(app);
    const response = (await postAction(
      app,
      action,
      cookie,
      { amount: 2 },
      {
        version: 2,
      },
    )) as Response;

    await expectPortableError(t, response, 406, 'unsupported_version', false);
  });

  it('rejects malformed action envelopes before dispatch', async (t) => {
    const { app } = makeApp();
    const { cookie, action } = await mountPortable(app);
    const response = (await app.handle(
      new Request(`http://local${action.url}`, {
        method: 'POST',
        headers: {
          accept: eventStreamAccept,
          'content-type': 'application/json',
          cookie,
        },
        body: 'null',
      }),
    )) as Response;

    await expectPortableError(t, response, 400, 'invalid_request', false);

    const missingNonce = (await postAction(
      app,
      action,
      cookie,
      { amount: 2 },
      {
        request: '',
      },
    )) as Response;
    await expectPortableError(t, missingNonce, 400, 'invalid_request', false);
  });

  it('acknowledges replayed action requests without running them twice', async (t) => {
    const { app, store } = makeApp();
    const { cookie, action } = await mountPortable(app);
    await postAction(app, action, cookie, { amount: 2 });
    const replay = (await postAction(app, action, cookie, { amount: 2 })) as Response;
    const events = await collectEvents(replay);
    t.equal(events.length, 1);
    t.equal(events[0]?.type, 'ui');
    t.deepEqual(events[0]?.data, { version: 1, kind: 'close' });
    t.deepEqual((await loadViewState(store, action.view))?.data, { count: 2 });
  });

  it('rejects stale action revisions with a recoverable SSE error', async (t) => {
    const { app } = makeApp();
    const { cookie, action } = await mountPortable(app);
    await postAction(app, action, cookie, { amount: 2 });
    const stale = (await postAction(
      app,
      action,
      cookie,
      { amount: 2 },
      {
        request: 'different-request',
      },
    )) as Response;
    await expectPortableError(t, stale, 409, 'stale_revision', true);
  });

  it('rejects actions from a different authenticated session', async (t) => {
    const { app } = makeApp();
    const { action } = await mountPortable(app);
    const response = (await postAction(app, action, undefined, { amount: 2 })) as Response;

    await expectPortableError(t, response, 403, 'forbidden', false);
  });

  it('reports an expired action view through the portable stream', async (t) => {
    const { app, store } = makeApp();
    const { cookie, action } = await mountPortable(app);
    await deleteViewState(store, action.view);

    const response = (await postAction(app, action, cookie, { amount: 2 })) as Response;
    await expectPortableError(t, response, 410, 'view_expired', false);
  });

  it('keeps handler diagnostics out of portable SSE errors', async (t) => {
    const { app } = makeApp();
    const { cookie, action } = await mountPortable(app);
    const response = (await postAction(app, action, cookie, { amount: 13 })) as Response;

    t.equal(response.status, 500);
    const body = await response.text();
    t.ok(!body.includes('sensitive handler details'));
    const events = [];
    for await (const event of parseEventStream(new Response(body).body!)) {
      events.push(JSON.parse(event.data));
    }
    t.deepEqual(events[0], {
      version: 1,
      kind: 'error',
      code: 'action_failed',
      recoverable: true,
    });
    t.deepEqual(events[1], { version: 1, kind: 'close' });
  });

  it('rejects oversized JSON actions before parsing input', async (t) => {
    const { app } = makeApp({ maxActionBytes: 128 });
    const { cookie, action } = await mountPortable(app);
    const response = (await postAction(app, action, cookie, {
      amount: 2,
      padding: 'x'.repeat(256),
    })) as Response;

    await expectPortableError(t, response, 413, 'action_too_large', false);
  });

  it('rejects non-data component props at the SSE boundary', async (t) => {
    const invalid = view({
      id: 'invalid-tree',
      state: () => ({}),
      render() {
        return h('app.invalid.v1', {
          callback() {},
        });
      },
    });
    const app = new App();
    const ui = app.layer(
      webUI({
        store: memoryStore(),
        secret: 'portable-ui-secret',
      }),
    );
    ui.get('/').handle(page((ctx) => invalid.mount(ctx)));

    const response = (await app.handle(
      new Request('http://local/', {
        headers: { accept: eventStreamAccept },
      }),
    )) as Response;

    await expectPortableError(t, response, 500, 'invalid_tree', false);
  });

  it('refuses an action addressed to a different view definition', async (t) => {
    const { app, store } = makeApp();
    view({
      id: 'portable-other',
      state: () => ({ secret: new Signal('untouched') }),
      actions: {
        escalate: {
          handler({ state }) {
            state.secret.set('escalated');
          },
        },
      },
      render: ({ state }) => h('app.other.v1', { secret: state.secret.get() }),
    });
    const { cookie, action } = await mountPortable(app);
    const swapped: PortableActionRef = {
      ...action,
      url: action.url.replace('portable-counter.increment', 'portable-other.escalate'),
    };

    const response = (await postAction(app, swapped, cookie, {})) as Response;
    await expectPortableError(t, response, 404, 'action_not_found', false);

    const snapshot = await loadViewState(store, action.view);
    t.equal(snapshot?.view, 'portable-counter', 'the snapshot keeps its own view definition');
    t.deepEqual(snapshot?.data, { count: 0 }, 'the other view cannot write this snapshot');
  });

  it('carries an action confirmation message to enhanced clients', async (t) => {
    const confirming = view({
      id: 'portable-confirm',
      state: () => ({ gone: new Signal(false) }),
      actions: {
        remove: {
          confirm: 'Delete this permanently?',
          handler({ state }) {
            state.gone.set(true);
          },
        },
      },
      render: ({ actions }) => h('app.danger.v1', { remove: actions.remove }),
    });
    const app = new App();
    const ui = app.layer(webUI({ store: memoryStore(), secret: 'portable-ui-secret' }));
    ui.get('/').handle(page((ctx) => confirming.mount(ctx)));

    const response = (await app.handle(
      new Request('http://local/', { headers: { accept: eventStreamAccept } }),
    )) as Response;
    const render = await firstEvent(response);
    const action = (render.data as PortableRenderEvent).tree.props
      .remove as unknown as PortableActionRef;

    t.equal(action.confirm, 'Delete this permanently?');
  });

  it('omits confirm from actions that do not declare one', async (t) => {
    const { app } = makeApp();
    const { action } = await mountPortable(app);

    t.equal(action.confirm, undefined, 'the field is absent rather than null');
  });

  it('reports a rejected request origin through the portable stream', async (t) => {
    const { app } = makeApp();
    const { cookie, action } = await mountPortable(app);
    const response = (await app.handle(
      new Request(`http://local${action.url}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie,
          origin: 'http://evil.example',
        },
        body: JSON.stringify({
          version: 1,
          view: action.view,
          revision: action.revision,
          request: action.request,
          input: { amount: 1 },
        }),
      }),
    )) as Response;

    await expectPortableError(t, response, 403, 'forbidden', false);
  });
});
