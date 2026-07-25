import { describe, it } from 'fino:test/test';
import { App } from 'fino:net/http/app';
import { parseEventStream } from 'fino:net/http/eventstream';
import { topic } from 'fino:context/topic';
import { h, Signal } from 'fino:ui';
import { page, view, webUI, clientScriptPath } from 'fino:ui/web';
import { InMemoryViewStore } from 'fino:ui/web/state';

function hidden(html: string, name: string): string {
  const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  if (!match) throw new Error(`missing hidden input ${name}`);
  return match[1]!;
}

function mountedViewId(html: string): string {
  const match = html.match(/<div id="([^"]+)" data-fi-view="live-todos"/);
  if (!match) throw new Error('missing mounted view wrapper');
  return match[1]!;
}

function makeApp() {
  const store = new InMemoryViewStore();
  const todos = view({
    id: 'live-todos',
    state: () => ({ items: new Signal<string[]>([]) }),
    actions: {},
    render({ state }) {
      return h('section', { id: 'live-todos' }, h('ul', null, state.items.get().map((item) => h('li', null, item))));
    }
  });
  const app = new App();
  const ui = app.layer(webUI({ store, secret: 'test-secret' }));
  ui.get('/').handle(page((ctx) => h('main', null, todos.mount(ctx))));
  return { app, store };
}

describe('fino:ui/web live and client endpoints', () => {
  it('serves the browser client without an explicit route', async (t) => {
    const { app } = makeApp();
    const response = await app.handle(new Request(`http://local${clientScriptPath()}`)) as Response;
    t.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
    t.ok((await response.text()).includes('EventSource'), 'client runtime source is served');
  });

  it('pushes a patch when a watched view topic is published', async (t) => {
    const { app, store } = makeApp();
    const first = await app.handle(new Request('http://local/')) as Response;
    const html = await first.text();
    const viewId = mountedViewId(html);
    const snap = (await store.load(viewId))!;
    await store.save({ ...snap, version: 1, data: { items: ['from topic'] } }, { expectVersion: 0 });

    const live = await app.handle(new Request(`http://local/_fino/live?view=${viewId}`, {
      headers: { accept: 'text/event-stream' }
    })) as Response;
    const iter = parseEventStream(live.body!)[Symbol.asyncIterator]();
    topic(`fino:ui/view:${viewId}`).publish({ version: 1 });
    const event = await iter.next();
    t.equal(event.value?.type, 'patch');
    t.ok(event.value?.data.includes('from topic'), 'patch contains re-rendered snapshot data');
    await iter.return?.();
  });

  it('catches up behind reconnects and navigates expired views', async (t) => {
    const { app, store } = makeApp();
    const first = await app.handle(new Request('http://local/')) as Response;
    const html = await first.text();
    const viewId = mountedViewId(html);
    const snap = (await store.load(viewId))!;
    await store.save({ ...snap, version: 2, data: { items: ['missed'] } }, { expectVersion: 0 });

    const behind = await app.handle(new Request(`http://local/_fino/live?view=${viewId}`, {
      headers: { accept: 'text/event-stream', 'last-event-id': '1' }
    })) as Response;
    const behindEvent = await parseEventStream(behind.body!)[Symbol.asyncIterator]().next();
    t.equal(behindEvent.value?.type, 'patch');
    t.ok(behindEvent.value?.data.includes('missed'), 'behind reconnect receives missed patch');

    await store.delete(viewId);
    const expired = await app.handle(new Request(`http://local/_fino/live?view=${viewId}`, {
      headers: { accept: 'text/event-stream', 'last-event-id': '2' }
    })) as Response;
    const expiredEvent = await parseEventStream(expired.body!)[Symbol.asyncIterator]().next();
    t.equal(expiredEvent.value?.type, 'navigate', 'missing snapshot navigates on reconnect');
  });

  it('disposes live topic subscriptions when the browser disconnects', async (t) => {
    const { app } = makeApp();
    const first = await app.handle(new Request('http://local/')) as Response;
    const viewId = mountedViewId(await first.text());
    const updates = topic(`fino:ui/view:${viewId}`);

    const live = await app.handle(new Request(`http://local/_fino/live?view=${viewId}`, {
      headers: { accept: 'text/event-stream' }
    })) as Response;
    t.ok(updates.hasSubscribers, 'live response subscribes to view updates');

    await live.body!.cancel();
    t.equal(updates.hasSubscribers, false, 'cancelling the response disposes subscriptions');
  });

  it('sweeps expired snapshots on the configured request cadence', async (t) => {
    const store = new InMemoryViewStore();
    let swept = 0;
    const originalSweep = store.sweep.bind(store);
    store.sweep = async (now?: number) => {
      swept++;
      return originalSweep(now);
    };
    const app = new App();
    app.layer(webUI({
      store,
      secret: 'test-secret',
      sweepIntervalMs: 0
    }));

    await app.handle(new Request('http://local/not-found'));
    await app.handle(new Request('http://local/still-not-found'));
    t.equal(swept, 2, 'zero interval sweeps once per request');
  });
});
