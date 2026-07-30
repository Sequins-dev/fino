import { memoryCache } from 'fino:cache';
import { App, cookies, sessions } from 'fino:net/http/app';
import { h } from 'fino:ui';
import { webUI } from 'fino:ui/web';
import { flowPage } from 'fino:ui/web/flow';
import { InMemoryViewStore } from 'fino:ui/web/state';
import { InMemoryWorkflowStore, workflow, type WorkflowState } from 'fino:workflow';
import { describe, it } from 'fino:test/test';

const approval = workflow({
  id: 'approval-flow',
  async run(ctx, input: { label: string }) {
    const approved = await ctx.waitForSignal<boolean>('approval');
    return { label: input.label, approved };
  },
});

const twoStep = workflow({
  id: 'two-step-flow',
  async run(ctx) {
    const first = await ctx.waitForSignal<string>('first');
    const second = await ctx.waitForSignal<string>('second');
    return { first, second };
  },
});

let pageCounter = 0;

function renderFlow(_ctx: unknown, state: WorkflowState, advance: unknown) {
  if (state.status === 'done')
    return h('p', { id: 'done' }, JSON.stringify(state.result ?? null));
  if (state.status === 'cancelled') return h('p', { id: 'cancelled' }, 'cancelled');
  return h(
    'form',
    { action: advance },
    h('input', { type: 'hidden', name: state.waitingOn?.name ?? 'none', value: 'true' }),
    h('button', null, state.waitingOn?.name ?? 'waiting'),
  );
}

function makeFlowApp(
  options: {
    flow?: typeof approval | typeof twoStep;
    session?: boolean;
    render?: typeof renderFlow;
  } = {},
) {
  const store = new InMemoryWorkflowStore();
  const app = new App();
  let layered = app.value('cookies', cookies());
  if (options.session !== false) {
    layered = layered.value(
      'session',
      sessions({
        store: memoryCache({ namespace: `flow-sessions-${pageCounter}` }),
        keys: [{ id: 'test', secret: 'flow-session-secret-value' }],
        ttlMs: 6e4,
      }),
    );
  }
  const ui = layered.layer(
    webUI({ store: new InMemoryViewStore(), secret: 'flow-ui-secret', sweepIntervalMs: false }),
  );
  const flow = options.flow ?? approval;
  ui.get('/flow').handle(
    flowPage(flow as typeof approval, {
      id: `fino:flow/test-${pageCounter++}`,
      store,
      start: () => ({ label: 'deploy' }),
      render: options.render ?? renderFlow,
    }),
  );
  return { app, store };
}

/** Accumulates Set-Cookie across a request sequence the way a browser would. */
function cookieJar() {
  const jar = new Map<string, string>();
  return {
    absorb(response: Response) {
      for (const raw of response.headers.getSetCookie()) {
        const [pair] = raw.split(';');
        const at = pair!.indexOf('=');
        if (at > 0) jar.set(pair!.slice(0, at), pair!.slice(at + 1));
      }
    },
    get header() {
      return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
    },
  };
}

async function startRun(app: App) {
  const jar = cookieJar();
  const start = (await app.handle(new Request('http://local/flow'))) as Response;
  jar.absorb(start);
  const location = start.headers.get('location')!;
  return {
    start,
    location,
    jar,
    runId: new URL(location, 'http://local').searchParams.get('run')!,
  };
}

async function loadPage(
  app: App,
  location: string,
  jar: ReturnType<typeof cookieJar> | string,
) {
  const header = typeof jar === 'string' ? jar : jar.header;
  const response = (await app.handle(
    new Request(`http://local${location}`, { headers: header ? { cookie: header } : {} }),
  )) as Response;
  if (typeof jar !== 'string') jar.absorb(response);
  return { response, html: await response.text() };
}

/**
 * Submit through the enhanced JSON action path.
 *
 * The no-JavaScript path is guarded by a single `fi_csrf` cookie, so only the
 * most recently rendered form holds a matching token. Multi-instance scenarios
 * use JSON actions, which authenticate by session instead.
 */
function submitJson(
  app: App,
  fields: ReturnType<typeof actionFields>,
  jar: ReturnType<typeof cookieJar> | string,
  input: Record<string, unknown>,
) {
  const header = typeof jar === 'string' ? jar : jar.header;
  return app.handle(
    new Request(`http://local${fields.url!.replace(/&amp;/g, '&')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: header },
      body: JSON.stringify({
        version: 1,
        view: fields.view,
        revision: Number(fields.ver),
        request: fields.nonce,
        input,
      }),
    }),
  ) as Promise<Response>;
}

/** First `ui` event kind and code from a JSON action response. */
async function uiResult(response: Response) {
  const body = await response.text();
  const first = /data: (\{.*\})/.exec(body)?.[1];
  const event = first === undefined ? null : (JSON.parse(first) as Record<string, unknown>);
  return { status: response.status, kind: event?.kind ?? null, code: event?.code ?? null };
}

/** Pull the hidden action fields webUI injects into a rendered form. */
function actionFields(html: string) {
  const field = (name: string) =>
    new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? null;
  return {
    view: field('_view'),
    ver: field('_ver'),
    nonce: field('_nonce'),
    csrf: field('_csrf'),
    url: /<form action="([^"]*)"/.exec(html)?.[1] ?? null,
  };
}

function submit(
  app: App,
  fields: ReturnType<typeof actionFields>,
  cookie: string | ReturnType<typeof cookieJar>,
  body: Record<string, string>,
) {
  const header = typeof cookie === 'string' ? cookie : cookie.header;
  return app.handle(
    new Request(`http://local${fields.url!.replace(/&amp;/g, '&')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: header },
      body: new URLSearchParams({
        _view: fields.view!,
        _ver: fields.ver!,
        _nonce: fields.nonce!,
        _csrf: fields.csrf!,
        ...body,
      }).toString(),
    }),
  ) as Promise<Response>;
}

describe('fino:ui/web/flow', () => {
  it('starts, renders, signals, resumes, and redirects a workflow-backed page', async (t) => {
    const { app } = makeFlowApp();
    const { start, location, jar } = await startRun(app);
    t.equal(start.status, 303, 'initial GET redirects to a run URL');
    t.ok(location.includes('run='), 'redirect includes run id');

    const waiting = await loadPage(app, location, jar);
    t.ok(waiting.html.includes('approval'), 'waiting step renders');

    const signaled = await submit(app, actionFields(waiting.html), jar, { approval: 'true' });
    t.equal(signaled.status, 303, 'no-JavaScript submit keeps POST-redirect-GET');

    const done = await loadPage(app, location, jar);
    t.ok(done.html.includes('&quot;approved&quot;:true'), 'completed result renders');
  });

  it('refuses a stale form once another tab advanced the run', async (t) => {
    const { app, store } = makeFlowApp({ flow: twoStep });
    const { location, jar, runId } = await startRun(app);
    // Two page loads mount two view instances, each valid at its own revision.
    const tabA = actionFields((await loadPage(app, location, jar)).html);
    const tabB = actionFields((await loadPage(app, location, jar)).html);

    const advanced = await uiResult(await submitJson(app, tabB, jar, { first: 'b' }));
    t.equal(advanced.kind, 'render', 'the second tab advances the run');

    const stale = await uiResult(await submitJson(app, tabA, jar, { first: 'a' }));
    t.equal(stale.status, 409, 'the first tab cannot advance a newer wait');
    t.equal(stale.code, 'flow_stale_step', 'and says why with a stable code');

    const state = (await store.load(runId))!;
    t.equal(state.waitingOn?.name, 'second', 'the run advanced exactly one step');
    t.equal(state.steps.find((step) => step?.id === 'first')?.result, 'b', 'only one payload landed');
  });

  it('does not run a signal twice for a duplicate submission', async (t) => {
    const { app, store } = makeFlowApp({ flow: twoStep });
    const { location, jar, runId } = await startRun(app);
    const fields = actionFields((await loadPage(app, location, jar)).html);

    const first = await uiResult(await submitJson(app, fields, jar, { first: 'once' }));
    t.equal(first.kind, 'render', 'the submit advances the run');

    const duplicate = await uiResult(await submitJson(app, fields, jar, { first: 'twice' }));
    t.equal(duplicate.status, 200, 'an identical resubmit is acknowledged, not re-run');
    t.equal(duplicate.kind, 'close', 'and closes without a new render');

    const state = (await store.load(runId))!;
    t.equal(
      state.steps.filter((step) => step?.id === 'first').length,
      1,
      'the signal is recorded once',
    );
    t.equal(state.steps.find((step) => step?.id === 'first')?.result, 'once', 'with the first payload');
  });

  it('serializes concurrent submissions from two tabs', async (t) => {
    const { app, store } = makeFlowApp({ flow: twoStep });
    const { location, jar, runId } = await startRun(app);
    const tabA = actionFields((await loadPage(app, location, jar)).html);
    const tabB = actionFields((await loadPage(app, location, jar)).html);

    const [resultA, resultB] = await Promise.all([
      submitJson(app, tabA, jar, { first: 'a' }).then(uiResult),
      submitJson(app, tabB, jar, { first: 'b' }).then(uiResult),
    ]);
    const renders = [resultA, resultB].filter((result) => result.kind === 'render');
    const rejected = [resultA, resultB].filter((result) => result.code === 'flow_stale_step');
    t.equal(renders.length, 1, 'exactly one concurrent submit advances the run');
    t.equal(rejected.length, 1, 'the other is rejected as a stale step');

    const state = (await store.load(runId))!;
    t.equal(state.waitingOn?.name, 'second', 'the run advanced exactly one step');
    t.equal(
      state.steps.filter((step) => step?.id === 'first').length,
      1,
      'and consumed one signal',
    );
  });

  it('rejects a run belonging to another session', async (t) => {
    const { app } = makeFlowApp();
    const { location, jar } = await startRun(app);
    const owner = await loadPage(app, location, jar);
    t.equal(owner.response.status, 200, 'the owning session can read the run');

    const stranger = await loadPage(app, location, '');
    t.equal(stranger.response.status, 403, 'another session cannot read the run');

    const attempt = await submit(app, actionFields(owner.html), '', { approval: 'true' });
    t.ok(attempt.status === 403, 'and cannot advance it');
  });

  it('reports a missing or foreign run without leaking which', async (t) => {
    const { app } = makeFlowApp();
    const missing = (await app.handle(
      new Request('http://local/flow?run=run_does_not_exist'),
    )) as Response;
    t.equal(missing.status, 404);

    const other = makeFlowApp({ flow: twoStep });
    const foreign = await startRun(other.app);
    const crossed = (await app.handle(
      new Request(`http://local/flow?run=${foreign.runId}`),
    )) as Response;
    t.equal(crossed.status, 404, 'a run from another workflow is not found here');
  });

  it('refuses to advance a completed run', async (t) => {
    const { app } = makeFlowApp();
    const { location, jar } = await startRun(app);
    const tabA = actionFields((await loadPage(app, location, jar)).html);
    const tabB = actionFields((await loadPage(app, location, jar)).html);

    const completed = await uiResult(await submitJson(app, tabB, jar, { approval: true }));
    t.equal(completed.kind, 'render', 'the run completes');

    const done = await loadPage(app, location, jar);
    t.ok(done.html.includes('id="done"'), 'the completed result renders');

    const again = await uiResult(await submitJson(app, tabA, jar, { approval: false }));
    t.equal(again.status, 409, 'a completed run cannot be advanced');
    t.equal(again.code, 'flow_not_waiting', 'and fails with a stable code');
  });

  it('refuses to advance a cancelled run', async (t) => {
    const { app, store } = makeFlowApp();
    const { location, jar, runId } = await startRun(app);
    const waiting = await loadPage(app, location, jar);
    const fields = actionFields(waiting.html);

    const state = (await store.load(runId))!;
    state.status = 'cancelled';
    delete state.waitingOn;
    await store.save(state);

    const attempt = await submit(app, fields, jar, { approval: 'true' });
    t.equal(attempt.status, 409);
    t.equal(await attempt.text(), 'flow_not_waiting');

    const rendered = await loadPage(app, location, jar);
    t.ok(rendered.html.includes('cancelled'), 'a cancelled run still renders');
  });

  it('serves a flow page as a semantic stream and keeps the run out of the view snapshot', async (t) => {
    const viewStore = new InMemoryViewStore();
    const store = new InMemoryWorkflowStore();
    const app = new App();
    const ui = app
      .value('cookies', cookies())
      .value(
        'session',
        sessions({
          store: memoryCache({ namespace: 'flow-sse-sessions' }),
          keys: [{ id: 'test', secret: 'flow-session-secret-value' }],
          ttlMs: 6e4,
        }),
      )
      .layer(webUI({ store: viewStore, secret: 'flow-ui-secret', sweepIntervalMs: false }));
    ui.get('/flow').handle(
      flowPage(approval, {
        id: 'fino:flow/sse-test',
        store,
        start: () => ({ label: 'deploy' }),
        render: renderFlow,
      }),
    );

    const { location, jar } = await startRun(app);
    const stream = (await app.handle(
      new Request(`http://local${location}`, {
        headers: { cookie: jar.header, accept: 'text/event-stream' },
      }),
    )) as Response;
    t.equal(stream.headers.get('content-type'), 'text/event-stream', 'the page streams JSON UI');

    const reader = stream.body!.getReader();
    const chunk = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(chunk.value);
    t.ok(text.includes('"kind":"render"'), 'the first event is a semantic render');

    const viewIdMatch = /"viewId":"(view_[a-f0-9]+)"/.exec(text)?.[1];
    t.ok(viewIdMatch !== undefined, 'the render names a mounted view');
    const snapshot = await viewStore.load(viewIdMatch!);
    t.deepEqual(
      Object.keys(snapshot!.data).sort(),
      ['awaitedName', 'awaitedStep', 'runId'],
      'the workflow run itself is derived, not copied into the snapshot',
    );
  });
});
