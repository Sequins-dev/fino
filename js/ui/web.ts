/**
 * fino:ui/web — server-driven HTML views for `fino:net/http/app`.
 *
 * This module renders `fino:ui` VNodes into real HTML pages and handles form
 * actions by rehydrating durable view snapshots. It is intentionally
 * hypermedia-first: forms keep real `action` and `method` attributes, enhanced
 * requests receive short-lived SSE patch streams, and plain browser submits use
 * POST-redirect-GET.
 *
 * ```ts no_run
 * import { App } from 'fino:net/http/app';
 * import { h, Signal } from 'fino:ui';
 * import { page, view, webUI } from 'fino:ui/web';
 * import { InMemoryViewStore } from 'fino:ui/web/state';
 *
 * const app = new App();
 * const ui = app.layer(webUI({ store: new InMemoryViewStore(), secret: 'dev-secret' }));
 * ui.get('/').handle(page(() => h('main', null, 'Hello')));
 * ```
 */
import { EventSourceWriter } from 'fino:net/http/eventstream';
import { topic } from 'fino:context/topic';
import { CLIENT_HASH, CLIENT_SOURCE } from 'internal:ui/web/client';
import { parseCookieHeader, sealCookie, serializeCookie, unsealCookie } from 'fino:security/cookie';
import { escapeHtml } from 'fino:template';
import { batch, h, Signal, type Props, type VNode } from 'fino:ui';
import { renderToHtml } from 'fino:ui/html';
import type { Handler, HttpContext, LayerMiddleware } from 'fino:net/http/app';
import type { ViewSnapshot, ViewStateStore } from 'fino:ui/web/state';
type StateRecord = Record<string, Signal<unknown>>;
/**
 * Context supplied to a server-driven view action.
 */
export interface ViewActionContext {
  /** Mutable signals restored from the durable snapshot. */
  state: StateRecord;
  /** Snapshot from which this action started. */
  snapshot: ViewSnapshot;
  /** HTTP request context for the action. */
  http: HttpContext;
  /**
   * Persist the current signals and publish a live patch before the action
   * finishes. Await checkpoints to preserve patch order.
   */
  checkpoint(): Promise<void>;
}
type ActionHandler = (
  ctx: ViewActionContext,
  input: Record<string, unknown>,
) => unknown | Promise<unknown>;
type ViewRender = (ctx: { state: StateRecord; actions: Record<string, ActionRef> }) => VNode;
type EmbedSpec =
  | string
  | {
      key: string;
      sealed?: boolean;
    };
export interface WebUIOptions {
  /** Durable snapshot store used for view state. */
  store: ViewStateStore;
  /** Secret used to seal CSRF tokens and sealed embedded state. */
  secret: string;
  /** Snapshot lifetime in milliseconds. Defaults to one hour. */
  ttlMs?: number;
  /**
   * Minimum time between opportunistic snapshot sweeps.
   *
   * Sweeps run before requests handled by this middleware. The default is one
   * minute. Set to `false` to operate cleanup from an external scheduler, or
   * `0` to sweep on every request (primarily useful in tests).
   */
  sweepIntervalMs?: number | false;
}
/**
 * Definition passed to `view()`.
 */
export interface ViewDefinition {
  /** Stable id used in action URLs and stored snapshots. */
  id: string;
  /** Factory called for each render or action event to create fresh signals. */
  state: () => StateRecord;
  /** Signal keys carried in HTML instead of the snapshot. */
  embed?: EmbedSpec[];
  /** Server actions addressable from rendered forms. */
  actions?: Record<
    string,
    {
      handler: ActionHandler;
      stale?: 'reject' | 'rebase';
    }
  >;
  /** Render function for the view's current state. */
  render: ViewRender;
}
const views = new Map<string, ServerView>();
class ActionRef {
  readonly view: ServerView;
  readonly name: string;
  readonly viewId: string;
  readonly version: number;
  readonly nonce: string;
  readonly csrf: string;
  readonly secret: string;
  readonly url: string;
  constructor(args: {
    view: ServerView;
    name: string;
    viewId: string;
    version: number;
    nonce: string;
    csrf: string;
    secret: string;
    url: string;
  }) {
    this.view = args.view;
    this.name = args.name;
    this.viewId = args.viewId;
    this.version = args.version;
    this.nonce = args.nonce;
    this.csrf = args.csrf;
    this.secret = args.secret;
    this.url = args.url;
  }
  toString(): string {
    return this.url;
  }
}
interface RenderEnv {
  ctx: HttpContext;
  options: WebUIOptions;
  csrfCookies: string[];
  pending: Promise<unknown>[];
}
let currentRender: RenderEnv | null = null;
const locks = new Map<string, Promise<void>>();
function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return `${prefix}_${hex}`;
}
function pageUrl(ctx: HttpContext): URL {
  const url = new URL(ctx.request.url);
  url.searchParams.delete('_action');
  return url;
}
function actionUrl(ctx: HttpContext, viewId: string, action: string): string {
  const url = pageUrl(ctx);
  url.searchParams.set('_action', `${viewId}.${action}`);
  return `${url.pathname}${url.search}`;
}
function sessionId(ctx: HttpContext): string | undefined {
  const session = ctx.session as
    | {
        id?: unknown;
      }
    | undefined;
  return typeof session?.id === 'string' ? session.id : undefined;
}
function signalValues(state: StateRecord, keys?: Set<string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, signal] of Object.entries(state)) {
    if (keys !== undefined && !keys.has(key)) continue;
    out[key] = signal.get();
  }
  return out;
}
function hydrate(state: StateRecord, values: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(values)) {
    state[key]?.set(value);
  }
}
function csrfPayload(viewId: string, nonce: string, secret: string): string {
  return sealCookie(
    JSON.stringify({
      viewId,
      nonce,
    }),
    secret,
  );
}
function verifyCsrf(ctx: HttpContext, form: FormData, secret: string): boolean {
  const token = String(form.get('_csrf') ?? '');
  const unsafeCookie =
    (
      ctx.request as Request & {
        _getUnsafeHeader?: (name: string) => string | null;
      }
    )._getUnsafeHeader?.('cookie') ?? null;
  const cookies = parseCookieHeader(ctx.request.headers.get('cookie') ?? unsafeCookie ?? '');
  if (token === '' || cookies.fi_csrf !== token) return false;
  const payload = unsealCookie(token, secret);
  if (payload === null) return false;
  try {
    const parsed = JSON.parse(payload) as {
      viewId?: unknown;
      nonce?: unknown;
    };
    return parsed.viewId === form.get('_view') && parsed.nonce === form.get('_nonce');
  } catch {
    return false;
  }
}
function verifyRequestOrigin(ctx: HttpContext): boolean {
  const site = ctx.request.headers.get('sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'same-site' && site !== 'none')
    return false;
  const origin = ctx.request.headers.get('origin');
  if (origin === null) return true;
  return new URL(origin).origin === new URL(ctx.request.url).origin;
}
async function withViewLock<T>(viewId: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(viewId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  locks.set(
    viewId,
    previous.then(() => current),
  );
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(viewId) === current) locks.delete(viewId);
  }
}
function formEntries(form: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (key.startsWith('_') || key.startsWith('$')) continue;
    out[key] = typeof value === 'string' ? value : value.name;
  }
  return out;
}
function embeddedEntries(
  form: FormData,
  view: ServerView,
  secret: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('$')) continue;
    const name = key.slice(1);
    const raw = typeof value === 'string' ? value : value.name;
    if (view.sealedEmbed.has(name)) {
      const unsealed = unsealCookie(raw, secret);
      if (unsealed === null) throw new Error(`Invalid sealed embedded state "${name}"`);
      out[name] = JSON.parse(unsealed);
    } else {
      out[name] = raw;
    }
  }
  return out;
}
function cloneProps(props: Props): Props {
  return { ...props };
}
function hidden(name: string, value: unknown): VNode {
  return h('input', {
    type: 'hidden',
    name,
    value: String(value),
  });
}
function annotateForms(node: VNode, actionRef?: ActionRef, state?: StateRecord): VNode {
  if (node.type === 'fragment') {
    return {
      ...node,
      children: node.children.map((child) =>
        typeof child === 'string' ? child : annotateForms(child, actionRef, state),
      ),
    };
  }
  const props = cloneProps(node.props);
  let currentAction = actionRef;
  if (node.type === 'form' && props.action instanceof ActionRef) {
    currentAction = props.action;
    props.action = currentAction.toString();
    props.method = props.method ?? 'post';
    props['data-fi-action'] = `${currentAction.view.def.id}.${currentAction.name}`;
  }
  const children = node.children.map((child) =>
    typeof child === 'string' ? child : annotateForms(child, currentAction, state),
  );
  if (node.type === 'form' && currentAction !== undefined) {
    children.unshift(
      hidden('_view', currentAction.viewId),
      hidden('_ver', currentAction.version),
      hidden('_nonce', currentAction.nonce),
      hidden('_csrf', currentAction.csrf),
    );
    for (const key of currentAction.view.embed) {
      const value = currentAction.view.sealedEmbed.has(key)
        ? sealCookie(
            JSON.stringify(state?.[key]?.get() ?? findInputValue(node, key) ?? ''),
            currentAction.secret,
          )
        : (findInputValue(node, key) ?? '');
      children.unshift(hidden(`$${key}`, value));
    }
  }
  return {
    ...node,
    props,
    children,
  };
}
function findInputValue(node: VNode, name: string): unknown {
  if (node.type === 'input' && node.props.name === name) return node.props.value ?? '';
  for (const child of node.children) {
    if (typeof child === 'string') continue;
    const value = findInputValue(child, name);
    if (value !== undefined) return value;
  }
  return undefined;
}
function hashHtml(html: string): string {
  let hash = 2166136261;
  for (let i = 0; i < html.length; i++) {
    hash ^= html.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
class ServerView {
  readonly def: ViewDefinition;
  readonly embed: Set<string>;
  readonly sealedEmbed: Set<string>;
  constructor(def: ViewDefinition) {
    this.def = def;
    this.embed = new Set(
      (def.embed ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.key)),
    );
    this.sealedEmbed = new Set(
      (def.embed ?? [])
        .filter((entry) => typeof entry !== 'string' && entry.sealed === true)
        .map(
          (entry) =>
            (
              entry as {
                key: string;
              }
            ).key,
        ),
    );
  }
  mount(ctx: HttpContext): VNode {
    if (currentRender === null)
      throw new Error('view.mount() must be called while rendering a page() handler');
    const state = this.def.state();
    const viewId = randomId('view');
    const nonce = randomId('render');
    const csrf = csrfPayload(viewId, nonce, currentRender.options.secret);
    const actions = this.actions(ctx, viewId, 0, nonce, csrf, currentRender.options.secret);
    const rendered = this.wrap(
      viewId,
      annotateForms(
        this.def.render({
          state,
          actions,
        }),
        undefined,
        state,
      ),
    );
    const html = renderToHtml(rendered);
    const now = Date.now();
    const data = signalValues(
      state,
      new Set(Object.keys(state).filter((key) => !this.embed.has(key))),
    );
    currentRender.pending.push(
      currentRender.options.store.save({
        viewId,
        view: this.def.id,
        version: 0,
        sessionId: sessionId(ctx),
        data,
        regions: { [viewId]: hashHtml(html) },
        applied: [],
        createdAt: now,
        updatedAt: now,
        expiresAt: now + (currentRender.options.ttlMs ?? 36e5),
      }),
    );
    currentRender.csrfCookies.push(
      serializeCookie('fi_csrf', csrf, {
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      }),
    );
    return rendered;
  }
  actions(
    ctx: HttpContext,
    viewId: string,
    version: number,
    nonce: string,
    csrf: string,
    secret: string,
  ): Record<string, ActionRef> {
    const out: Record<string, ActionRef> = {};
    for (const name of Object.keys(this.def.actions ?? {})) {
      out[name] = new ActionRef({
        view: this,
        name,
        viewId,
        version,
        nonce,
        csrf,
        secret,
        url: actionUrl(ctx, this.def.id, name),
      });
    }
    return out;
  }
  renderSnapshot(
    ctx: HttpContext,
    snapshot: ViewSnapshot,
    state: StateRecord,
    nonce: string,
    csrf: string,
    secret: string,
  ): {
    html: string;
    hash: string;
  } {
    const rendered = this.wrap(
      snapshot.viewId,
      annotateForms(
        this.def.render({
          state,
          actions: this.actions(ctx, snapshot.viewId, snapshot.version, nonce, csrf, secret),
        }),
        undefined,
        state,
      ),
    );
    const html = renderToHtml(rendered);
    return {
      html,
      hash: hashHtml(html),
    };
  }
  wrap(viewId: string, child: VNode): VNode {
    return h(
      'div',
      {
        id: viewId,
        'data-fi-view': this.def.id,
      },
      child,
    );
  }
}
/**
 * Create a server-driven view definition.
 */
export function view(def: ViewDefinition): ServerView {
  const serverView = new ServerView(def);
  views.set(def.id, serverView);
  return serverView;
}
async function writeEvent(
  writer: WritableStreamDefaultWriter<Uint8Array>,
  event: {
    event: string;
    data: unknown;
    id?: string;
  },
): Promise<void> {
  const es = new EventSourceWriter({ write: (chunk) => writer.write(chunk) });
  await es.event({
    event: event.event,
    data: JSON.stringify(event.data),
    id: event.id,
  });
}
function writeSse(
  controller: ReadableStreamDefaultController<Uint8Array>,
  event: {
    event: string;
    data: unknown;
    id?: string;
  },
): void {
  const lines: string[] = [`event: ${event.event}`];
  for (const line of JSON.stringify(event.data).split('\n')) lines.push(`data: ${line}`);
  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  controller.enqueue(new TextEncoder().encode(lines.join('\n') + '\n\n'));
}
function sseResponse(
  events: Array<{
    event: string;
    data: unknown;
    id?: string;
  }>,
): Response {
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const writer = new WritableStream<Uint8Array>({
        write(chunk) {
          controller.enqueue(chunk);
        },
      }).getWriter();
      for (const event of events) await writeEvent(writer, event);
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}
async function handleAction(ctx: HttpContext, options: WebUIOptions): Promise<Response> {
  if (!verifyRequestOrigin(ctx)) return new Response('Forbidden', { status: 403 });
  const form = await ctx.request.formData();
  if (!verifyCsrf(ctx, form, options.secret)) return new Response('Forbidden', { status: 403 });
  const viewId = String(form.get('_view') ?? '');
  const actionName = new URL(ctx.request.url).searchParams.get('_action') ?? '';
  const [viewName, name] = actionName.split('.');
  const serverView = viewName ? views.get(viewName) : undefined;
  const action = name ? serverView?.def.actions?.[name] : undefined;
  if (serverView === undefined || action === undefined || viewId === '')
    return new Response('Not Found', { status: 404 });
  return withViewLock(viewId, async () => {
    const snapshot = await options.store.load(viewId);
    if (snapshot === null) return new Response('Gone', { status: 410 });
    if (snapshot.sessionId !== undefined && snapshot.sessionId !== sessionId(ctx))
      return new Response('Forbidden', { status: 403 });
    const requestVersion = Number(form.get('_ver') ?? -1);
    const nonce = String(form.get('_nonce') ?? '');
    const rid = `${requestVersion}:${nonce}`;
    if (snapshot.applied.some((entry) => entry.rid === rid && entry.action === name)) {
      return wantsSse(ctx)
        ? sseResponse([
            {
              event: 'close',
              data: {},
              id: String(snapshot.version),
            },
          ])
        : redirectBack(ctx);
    }
    if (requestVersion !== snapshot.version && action.stale !== 'rebase')
      return new Response('Conflict', { status: 409 });
    const state = serverView.def.state();
    hydrate(state, snapshot.data);
    try {
      hydrate(state, embeddedEntries(form, serverView, options.secret));
    } catch (err) {
      return new Response((err as Error).message, { status: 400 });
    }
    let currentSnapshot = snapshot;
    const commit = async (complete: boolean) => {
      const data = signalValues(
        state,
        new Set(Object.keys(state).filter((key) => !serverView.embed.has(key))),
      );
      const nextVersion = currentSnapshot.version + 1;
      const nextNonce = randomId('render');
      const csrf = csrfPayload(viewId, nextNonce, options.secret);
      const nextSnapshot: ViewSnapshot = {
        ...currentSnapshot,
        version: nextVersion,
        data,
        applied: complete
          ? [
              {
                rid,
                action: name,
              },
              ...currentSnapshot.applied,
            ].slice(0, 16)
          : currentSnapshot.applied,
        updatedAt: Date.now(),
      };
      const rendered = serverView.renderSnapshot(
        ctx,
        nextSnapshot,
        state,
        nextNonce,
        csrf,
        options.secret,
      );
      nextSnapshot.regions = { [viewId]: rendered.hash };
      await options.store.save(nextSnapshot, { expectVersion: currentSnapshot.version });
      currentSnapshot = nextSnapshot;
      topic(`fino:ui/view:${viewId}`).publish({ version: nextVersion });
      return rendered;
    };
    await batch(() =>
      action.handler(
        {
          state,
          snapshot,
          http: ctx,
          checkpoint: () => commit(false).then(() => {}),
        },
        formEntries(form),
      ),
    );
    const rendered = await commit(true);
    if (!wantsSse(ctx)) return redirectBack(ctx);
    return sseResponse([
      {
        event: 'patch',
        data: {
          id: viewId,
          mode: 'replace',
          html: rendered.html,
        },
        id: String(currentSnapshot.version),
      },
      {
        event: 'close',
        data: {},
        id: String(currentSnapshot.version),
      },
    ]);
  });
}
function renderLivePatch(
  ctx: HttpContext,
  options: WebUIOptions,
  snapshot: ViewSnapshot,
): {
  id: string;
  html: string;
  version: number;
} | null {
  const serverView = views.get(snapshot.view);
  if (serverView === undefined) return null;
  const state = serverView.def.state();
  hydrate(state, snapshot.data);
  const nonce = randomId('render');
  const csrf = csrfPayload(snapshot.viewId, nonce, options.secret);
  const rendered = serverView.renderSnapshot(ctx, snapshot, state, nonce, csrf, options.secret);
  return {
    id: snapshot.viewId,
    html: rendered.html,
    version: snapshot.version,
  };
}
function handleLive(ctx: HttpContext, options: WebUIOptions): Response {
  const viewsParam = new URL(ctx.request.url).searchParams.get('view') ?? '';
  const viewIds = viewsParam
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (viewIds.length === 0) return new Response('Missing view', { status: 400 });
  const lastEventId = Number(ctx.request.headers.get('last-event-id') ?? -1);
  const pagePath = new URL(ctx.request.url).pathname || '/';
  const sendSnapshot = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
    viewId: string,
    force = false,
  ) => {
    const snapshot = await options.store.load(viewId);
    if (
      snapshot === null ||
      (snapshot.sessionId !== undefined && snapshot.sessionId !== sessionId(ctx))
    ) {
      writeSse(controller, {
        event: 'navigate',
        data: {
          url: pagePath,
          replace: true,
        },
      });
      return;
    }
    if (!force && Number.isFinite(lastEventId) && lastEventId >= snapshot.version) return;
    const patch = renderLivePatch(ctx, options, snapshot);
    if (patch !== null)
      writeSse(controller, {
        event: 'patch',
        data: {
          id: patch.id,
          mode: 'replace',
          html: patch.html,
        },
        id: String(patch.version),
      });
  };
  let handles: Array<{
    dispose(): void;
  }> = [];
  const dispose = () => {
    for (const handle of handles) handle.dispose();
    handles = [];
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(': connected\n\n'));
      handles = viewIds.map((viewId) =>
        topic(`fino:ui/view:${viewId}`).subscribe(() => {
          void sendSnapshot(controller, viewId, true).catch(() => {});
        }),
      );
      for (const viewId of viewIds) void sendSnapshot(controller, viewId).catch(() => {});
    },
    cancel: dispose,
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}
/**
 * Return the content-hashed browser runtime path served by `webUI()`.
 */
export function clientScriptPath(): string {
  return `/_fino/client.${CLIENT_HASH}.js`;
}
function wantsSse(ctx: HttpContext): boolean {
  return (ctx.request.headers.get('accept') ?? '').includes('text/event-stream');
}
function redirectBack(ctx: HttpContext): Response {
  const url = pageUrl(ctx);
  return new Response(null, {
    status: 303,
    headers: { location: `${url.pathname}${url.search}` },
  });
}
/**
 * Middleware that installs server-driven UI handling for an `App`.
 */
export function webUI(options: WebUIOptions): LayerMiddleware {
  if (!options.secret) throw new Error('webUI requires a secret for CSRF protection');
  const sweepIntervalMs = options.sweepIntervalMs === undefined ? 6e4 : options.sweepIntervalMs;
  let nextSweepAt = 0;
  let sweeping: Promise<void> | null = null;
  const sweepIfDue = async () => {
    if (sweepIntervalMs === false) return;
    const now = Date.now();
    if (now < nextSweepAt) return;
    nextSweepAt = now + Math.max(0, sweepIntervalMs);
    sweeping ??= (async () => {
      const startedAt = Date.now();
      try {
        const deleted = await options.store.sweep(now);
        topic('fino:ui/sweep').publish({
          deleted,
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        topic('fino:ui/sweep:error').publish(error);
      } finally {
        sweeping = null;
      }
    })();
    await sweeping;
  };
  return async (ctx, next) => {
    await sweepIfDue();
    const url = new URL(ctx.request.url);
    if (ctx.request.method === 'GET' && url.pathname === clientScriptPath()) {
      return new Response(CLIENT_SOURCE, {
        headers: {
          'content-type': 'text/javascript; charset=utf-8',
          'cache-control': 'public, max-age=31536000, immutable',
        },
      });
    }
    if (ctx.request.method === 'GET' && url.pathname === '/_fino/live')
      return handleLive(ctx, options);
    if (ctx.request.method === 'POST' && url.searchParams.has('_action'))
      return handleAction(ctx, options);
    ctx.__finoUI = options;
    return next();
  };
}
/**
 * Create a page route handler that renders VNodes to a full HTML response.
 */
export function page(render: (ctx: HttpContext) => VNode): Handler {
  return async (ctx) => {
    const options = ctx.__finoUI as WebUIOptions | undefined;
    if (options === undefined) throw new Error('page() requires webUI() middleware');
    const env: RenderEnv = {
      ctx,
      options,
      csrfCookies: [],
      pending: [],
    };
    currentRender = env;
    try {
      const html = '<!doctype html>' + renderToHtml(render(ctx));
      await Promise.all(env.pending);
      const res = new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
      for (const cookie of env.csrfCookies)
        (
          res.headers as Headers & {
            _appendTrusted(name: string, value: string): void;
          }
        )._appendTrusted('set-cookie', cookie);
      return res;
    } finally {
      currentRender = null;
    }
  };
}
export { escapeHtml };
