/**
 * fino:ui/web — server-driven HTML and semantic UI for
 * `fino:net/http/app`.
 *
 * This module renders `fino:ui` VNodes into real HTML pages and handles form
 * actions by rehydrating durable view snapshots. It is intentionally
 * hypermedia-first: forms keep real `action` and `method` attributes, enhanced
 * requests receive short-lived JSON UI streams, and plain browser submits use
 * POST-redirect-GET.
 *
 * Every SSE response uses the same JSON `ui` events and host-neutral VNode
 * structure. A client can open a page route directly as an EventSource and
 * receive the current snapshot before subsequent updates. Component type names
 * are routed by the client through its own host adapter. The server owns view
 * state and action execution, but it does not register platform component
 * implementations or receive client-local interaction state.
 *
 * ```ts no_run
 * import { App } from 'fino:net/http/app';
 * import { h, Signal } from 'fino:ui';
 * import { page, view, webUI } from 'fino:ui/web';
 * import { memoryStore } from 'fino:store';
 *
 * const app = new App();
 * const ui = app.layer(webUI({ store: memoryStore(), secret: 'dev-secret' }));
 * ui.get('/').handle(page(() => h('main', null, 'Hello')));
 * ```
 */
import { EventSourceWriter } from 'fino:net/http/eventstream';
import { topic } from 'fino:context/topic';
import { CLIENT_HASH, CLIENT_SOURCE } from 'internal:ui/web/client';
import { parseCookieHeader, sealCookie, serializeCookie, unsealCookie } from 'fino:security/cookie';
import { escapeHtml } from 'fino:template';
import { batch, h, renderStatic, Signal, type Props, type Sink, type VNode } from 'fino:ui';
import { renderToHtml } from 'fino:ui/html';
import { toPortable, type PortableVNode } from 'fino:ui/portable';
import { parse as parseSchema, type JsonSchema } from 'fino:validate';
import type { Handler, HttpContext, LayerMiddleware } from 'fino:net/http/app';
import { loadViewState, saveViewState, sweepViewState, type ViewSnapshot } from 'fino:ui/web/state';
import type { AtomicStore } from 'fino:store';
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
   * Persist the current signals and publish a live render before the action
   * finishes. Await checkpoints to preserve render order.
   */
  checkpoint(): Promise<void>;
}
type ActionHandler = (
  ctx: ViewActionContext,
  input: Record<string, unknown>,
) => unknown | Promise<unknown>;
type ViewRender = (ctx: {
  state: StateRecord;
  actions: Record<string, PortableActionRef>;
}) => VNode;
type EmbedSpec =
  | string
  | {
      key: string;
      sealed?: boolean;
    };
export type { PortableValue, PortableVNode } from 'fino:ui/portable';
/**
 * Sink that hands back the tree it was given.
 *
 * View rendering needs the tree itself, because form annotation and portability
 * conversion happen after the component runs. Going through a sink anyway means
 * a view's render pass gets the same one-shot guarantees as every other: a
 * component that mutates a signal mid-render is reported rather than silently
 * producing output that disagrees with its own state.
 */
function passthroughSink(): Sink<VNode> {
  return {
    commit(tree: VNode): VNode {
      return tree;
    },
  };
}
/**
 * Serializable action descriptor embedded in component props.
 *
 * Send these fields back in a `PortableActionRequest`; do not construct action
 * URLs or revision tokens in the client.
 */
export interface PortableActionRef {
  /** Action name within the mounted view. */
  action: string;
  /** Relative HTTP endpoint for the action request. */
  url: string;
  /** Mounted view instance id. */
  view: string;
  /** Snapshot revision from which the action was rendered. */
  revision: number;
  /** Single-use request nonce for replay protection. */
  request: string;
  /** Message a client should confirm before sending the request. */
  confirm?: string;
}
/**
 * JSON body posted by a client to a `PortableActionRef.url`.
 */
export interface PortableActionRequest {
  /** UI protocol version. Version 1 is currently supported. */
  version: 1;
  /** Mounted view instance id from the action descriptor. */
  view: string;
  /** Snapshot revision from the action descriptor. */
  revision: number;
  /** Request nonce from the action descriptor. */
  request: string;
  /** Optional JSON object validated by the action's input schema. */
  input?: Record<string, PortableValue>;
}
/**
 * Complete semantic render of one mounted view.
 *
 * Clients reconcile `tree` against the previous tree using component names and
 * keys. The server does not keep or receive a registry of client
 * implementations.
 */
export interface PortableRenderEvent {
  /** UI protocol version. */
  version: 1;
  /** Render event discriminator. */
  kind: 'render';
  /** Stable server view definition id. */
  view: string;
  /** Mounted view instance id. */
  viewId: string;
  /** Monotonic snapshot revision, also sent as the SSE event id. */
  revision: number;
  /** Host-neutral component tree. */
  tree: PortableVNode;
}
/**
 * Event carried under the SSE `ui` event name.
 *
 * A live stream starts with `render` (or `navigate` when its view expired).
 * `render` replaces the current semantic tree, `heartbeat` can confirm a live
 * stream, `navigate` requests a page transition, `error` reports a safe
 * protocol failure, and `close` ends a short-lived action or error stream.
 */
export type PortableUIEvent =
  | PortableRenderEvent
  | { version: 1; kind: 'heartbeat' }
  | { version: 1; kind: 'navigate'; url: string; replace: boolean }
  | { version: 1; kind: 'error'; code: string; recoverable: boolean }
  | { version: 1; kind: 'close' };
export interface WebUIOptions {
  /** Generic atomic store used for durable view snapshots. */
  store: AtomicStore;
  /** Secret used to seal CSRF tokens and sealed embedded state. */
  secret: string;
  /** Snapshot lifetime in milliseconds. Defaults to one hour. */
  ttlMs?: number;
  /** Maximum JSON action body size in bytes. Defaults to 64 KiB. */
  maxActionBytes?: number;
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
      /** Action implementation run against the restored view snapshot. */
      handler: ActionHandler;
      /** Optional schema used to validate JSON and form input. */
      input?: JsonSchema;
      /** Whether an operation may safely rebase onto a newer snapshot. */
      stale?: 'reject' | 'rebase';
      /**
       * Message an enhanced client should confirm before sending the request.
       *
       * This is presentation only. It is not enforced on the server and the
       * no-JavaScript fallback submits without it.
       */
      confirm?: string;
    }
  >;
  /**
   * Signal keys projected from an authoritative external store.
   *
   * Derived signals are rendered but never written to the view snapshot, so a
   * store that already owns the data stays the only durable copy. Seed them
   * through `derive` rather than expecting hydration to restore them.
   */
  derived?: string[];
  /**
   * Populate `derived` signals before a render web.ts owns.
   *
   * This runs on the action and live-stream paths, which are already async. The
   * initial `mount()` render is synchronous, so a caller that mounts a view with
   * derived signals must seed them before calling `mount()`.
   */
  derive?: (args: {
    state: StateRecord;
    http: HttpContext;
    snapshot: ViewSnapshot;
  }) => void | Promise<void>;
  /** Render function for the view's current state. */
  render: ViewRender;
}
/**
 * Action failure that carries a stable, publicly safe error code.
 *
 * An action handler throws this when the caller should learn *why* the request
 * failed. Any other thrown value is reported as `action_failed` with its details
 * published only to the internal diagnostics topic, so a handler must opt in
 * before anything reaches the client.
 *
 * ```ts no_run
 * import { ViewActionError } from 'fino:ui/web';
 *
 * throw new ViewActionError('flow_stale_step', { status: 409, recoverable: true });
 * ```
 */
export class ViewActionError extends Error {
  /** Stable code sent to clients as the SSE error code. */
  readonly code: string;
  /** HTTP status for the action response. */
  readonly status: number;
  /** Whether a client may retry after resynchronizing. */
  readonly recoverable: boolean;
  constructor(
    code: string,
    options: { status?: number; recoverable?: boolean; message?: string } = {},
  ) {
    super(options.message ?? code);
    this.name = 'ViewActionError';
    this.code = code;
    this.status = options.status ?? 409;
    this.recoverable = options.recoverable ?? true;
  }
}
const views = new Map<string, ServerView>();
/**
 * Per-instance data an action needs but must never be rendered into.
 *
 * The CSRF token and the sealing secret belong to the request, not to the view's
 * output. Keeping them here instead of on the descriptor in `props` means the
 * render tree holds only what is safe to send: a tree can be serialized,
 * streamed, or rendered in another isolate without a secret riding along.
 */
interface ActionContext {
  view: ServerView;
  viewId: string;
  version: number;
  nonce: string;
  csrf: string;
  secret: string;
}
function isActionRef(value: unknown): value is PortableActionRef {
  if (value === null || typeof value !== 'object') return false;
  const ref = value as Partial<PortableActionRef>;
  return (
    typeof ref.action === 'string' &&
    typeof ref.url === 'string' &&
    typeof ref.view === 'string' &&
    typeof ref.revision === 'number' &&
    typeof ref.request === 'string'
  );
}
interface RenderEnv {
  ctx: HttpContext;
  options: WebUIOptions;
  streaming: boolean;
  mounts: PortableRenderEvent[];
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
function actionUrl(ctx: HttpContext, viewId: string, action: string, pagePath?: string): string {
  const url = pagePath === undefined ? pageUrl(ctx) : new URL(pagePath, ctx.request.url);
  url.searchParams.delete('_action');
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
/**
 * Read a header that public `Request` guards may hide.
 *
 * Wire requests expose every header directly. Requests constructed in JS hide
 * forbidden names such as `cookie` and `origin` behind the same guard a browser
 * applies, so fall back to the original constructor headers.
 */
function requestHeader(ctx: HttpContext, name: string): string | null {
  return (
    ctx.request.headers.get(name) ??
    (
      ctx.request as Request & {
        _getUnsafeHeader?: (name: string) => string | null;
      }
    )._getUnsafeHeader?.(name) ??
    null
  );
}
function verifyCsrf(ctx: HttpContext, form: FormData, secret: string): boolean {
  const token = String(form.get('_csrf') ?? '');
  const cookies = parseCookieHeader(requestHeader(ctx, 'cookie') ?? '');
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
  const site = requestHeader(ctx, 'sec-fetch-site');
  if (site !== null && site !== 'same-origin' && site !== 'same-site' && site !== 'none')
    return false;
  const origin = requestHeader(ctx, 'origin');
  if (origin === null) return true;
  try {
    return new URL(origin).origin === new URL(ctx.request.url).origin;
  } catch {
    return false;
  }
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
function annotateForms(
  node: VNode,
  ctx: ActionContext,
  state?: StateRecord,
  inForm = false,
): VNode {
  if (node.type === 'fragment') {
    return {
      ...node,
      children: node.children.map((child) =>
        typeof child === 'string' ? child : annotateForms(child, ctx, state, inForm),
      ),
    };
  }
  const props = cloneProps(node.props);
  let formAction = inForm;
  if (node.type === 'form' && isActionRef(props.action)) {
    const ref = props.action;
    formAction = true;
    props.action = ref.url;
    props.method = props.method ?? 'post';
    props['data-fi-action'] = `${ctx.view.def.id}.${ref.action}`;
  }
  const children = node.children.map((child) =>
    typeof child === 'string' ? child : annotateForms(child, ctx, state, formAction),
  );
  if (node.type === 'form' && formAction) {
    children.unshift(
      hidden('_view', ctx.viewId),
      hidden('_ver', ctx.version),
      hidden('_nonce', ctx.nonce),
      hidden('_csrf', ctx.csrf),
    );
    for (const key of ctx.view.embed) {
      const value = ctx.view.sealedEmbed.has(key)
        ? sealCookie(
            JSON.stringify(state?.[key]?.get() ?? findInputValue(node, key) ?? ''),
            ctx.secret,
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
  readonly derived: Set<string>;
  constructor(def: ViewDefinition) {
    this.def = def;
    this.derived = new Set(def.derived ?? []);
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
  /** Signal values that belong in the snapshot, excluding embedded and derived keys. */
  persisted(state: StateRecord): Record<string, unknown> {
    return signalValues(
      state,
      new Set(Object.keys(state).filter((key) => !this.embed.has(key) && !this.derived.has(key))),
    );
  }
  /**
   * Render a fresh instance of this view into the page currently being rendered.
   *
   * `seed` presets signal values before the first render. A view with derived
   * signals needs it, because `mount()` is synchronous and cannot await
   * `derive`; the caller's handler is the one place that can load first.
   */
  mount(ctx: HttpContext, seed?: Record<string, unknown>): VNode {
    if (currentRender === null)
      throw new Error('view.mount() must be called while rendering a page() handler');
    const state = this.def.state();
    if (seed !== undefined) hydrate(state, seed);
    const viewId = randomId('view');
    const nonce = randomId('render');
    const csrf = csrfPayload(viewId, nonce, currentRender.options.secret);
    const secret = currentRender.options.secret;
    const actions = this.actions(ctx, viewId, 0, nonce);
    const actionCtx: ActionContext = {
      view: this,
      viewId,
      version: 0,
      nonce,
      csrf,
      secret,
    };
    const streaming = currentRender.streaming;
    const rawTree = renderStatic(() => this.def.render({ state, actions }), passthroughSink());
    const tree = streaming ? (toPortable(rawTree) as unknown as VNode) : rawTree;
    const rendered = streaming ? tree : this.wrap(viewId, annotateForms(tree, actionCtx, state));
    const encoded = streaming ? JSON.stringify(tree) : renderToHtml(rendered);
    const now = Date.now();
    const data = this.persisted(state);
    currentRender.pending.push(
      saveViewState(currentRender.options.store, {
        viewId,
        view: this.def.id,
        version: 0,
        sessionId: sessionId(ctx),
        data,
        regions: { [viewId]: hashHtml(encoded) },
        applied: [],
        createdAt: now,
        updatedAt: now,
        expiresAt: now + (currentRender.options.ttlMs ?? 36e5),
      }),
    );
    if (currentRender.streaming) {
      currentRender.mounts.push({
        version: 1,
        kind: 'render',
        view: this.def.id,
        viewId,
        revision: 0,
        tree,
      });
    }
    currentRender.csrfCookies.push(
      serializeCookie('fi_csrf', csrf, {
        path: '/',
        httpOnly: true,
        sameSite: 'Lax',
      }),
    );
    return rendered;
  }
  /**
   * Build the action descriptors handed to a render.
   *
   * These are plain portable data. Everything an action needs that must not be
   * rendered — the CSRF token, the sealing secret — stays in an `ActionContext`
   * the sink consults instead.
   */
  actions(
    ctx: HttpContext,
    viewId: string,
    version: number,
    nonce: string,
    pagePath?: string,
  ): Record<string, PortableActionRef> {
    const out: Record<string, PortableActionRef> = {};
    for (const [name, action] of Object.entries(this.def.actions ?? {})) {
      const ref: PortableActionRef = {
        action: name,
        url: actionUrl(ctx, this.def.id, name, pagePath),
        view: viewId,
        revision: version,
        request: nonce,
      };
      if (action.confirm !== undefined) ref.confirm = action.confirm;
      out[name] = ref;
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
    semantic = false,
    pagePath?: string,
  ): {
    html: string;
    hash: string;
    tree: VNode;
  } {
    const actions = this.actions(ctx, snapshot.viewId, snapshot.version, nonce, pagePath);
    const actionCtx: ActionContext = {
      view: this,
      viewId: snapshot.viewId,
      version: snapshot.version,
      nonce,
      csrf,
      secret,
    };
    const rawTree = renderStatic(() => this.def.render({ state, actions }), passthroughSink());
    const tree = semantic ? (toPortable(rawTree) as unknown as VNode) : rawTree;
    const rendered = semantic
      ? tree
      : this.wrap(snapshot.viewId, annotateForms(tree, actionCtx, state));
    const html = semantic ? '' : renderToHtml(rendered);
    return {
      html,
      hash: hashHtml(semantic ? JSON.stringify(tree) : html),
      tree,
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
  status = 200,
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
  return new Response(stream, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}
function portableError(status: number, code: string, recoverable: boolean): Response {
  return sseResponse(
    [
      {
        event: 'ui',
        data: { version: 1, kind: 'error', code, recoverable },
      },
      {
        event: 'ui',
        data: { version: 1, kind: 'close' },
      },
    ],
    status,
  );
}
async function handleAction(ctx: HttpContext, options: WebUIOptions): Promise<Response> {
  const isJson = (ctx.request.headers.get('content-type') ?? '')
    .toLowerCase()
    .startsWith('application/json');
  const streaming = isJson || wantsSse(ctx);
  if (!verifyRequestOrigin(ctx))
    return streaming
      ? portableError(403, 'forbidden', false)
      : new Response('Forbidden', { status: 403 });
  let form: FormData | null = null;
  let viewId = '';
  let requestVersion = -1;
  let nonce = '';
  let input: Record<string, unknown> = {};
  if (isJson) {
    if (sessionId(ctx) === undefined) return portableError(403, 'forbidden', false);
    const maxActionBytes = options.maxActionBytes ?? 65_536;
    const declared = Number(ctx.request.headers.get('content-length') ?? Number.NaN);
    if (Number.isFinite(declared) && declared > maxActionBytes)
      return portableError(413, 'action_too_large', false);
    const encoded = await ctx.request.text();
    if (new TextEncoder().encode(encoded).byteLength > maxActionBytes)
      return portableError(413, 'action_too_large', false);
    type ActionBody = {
      version?: unknown;
      view?: unknown;
      revision?: unknown;
      request?: unknown;
      input?: unknown;
    };
    let decoded: unknown;
    try {
      decoded = JSON.parse(encoded);
    } catch {
      return portableError(400, 'invalid_request', false);
    }
    if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded))
      return portableError(400, 'invalid_request', false);
    const body = decoded as ActionBody;
    if (body.version !== 1) return portableError(406, 'unsupported_version', false);
    if (
      typeof body.view !== 'string' ||
      body.view === '' ||
      typeof body.revision !== 'number' ||
      !Number.isSafeInteger(body.revision) ||
      body.revision < 0 ||
      typeof body.request !== 'string' ||
      body.request === '' ||
      (body.input !== undefined &&
        (body.input === null || typeof body.input !== 'object' || Array.isArray(body.input)))
    )
      return portableError(400, 'invalid_request', false);
    viewId = body.view;
    requestVersion = body.revision;
    nonce = body.request;
    input = (body.input ?? {}) as Record<string, unknown>;
  } else {
    form = await ctx.request.formData();
    if (!verifyCsrf(ctx, form, options.secret))
      return streaming
        ? portableError(403, 'forbidden', false)
        : new Response('Forbidden', { status: 403 });
    viewId = String(form.get('_view') ?? '');
    requestVersion = Number(form.get('_ver') ?? -1);
    nonce = String(form.get('_nonce') ?? '');
    input = formEntries(form);
  }
  const actionName = new URL(ctx.request.url).searchParams.get('_action') ?? '';
  const [viewName, name] = actionName.split('.');
  const serverView = viewName ? views.get(viewName) : undefined;
  const action = name ? serverView?.def.actions?.[name] : undefined;
  if (serverView === undefined || action === undefined || viewId === '')
    return streaming
      ? portableError(404, 'action_not_found', false)
      : new Response('Not Found', { status: 404 });
  return withViewLock(viewId, async () => {
    const snapshot = await loadViewState(options.store, viewId);
    if (snapshot === null)
      return streaming
        ? portableError(410, 'view_expired', false)
        : new Response('Gone', { status: 410 });
    if (snapshot.sessionId !== undefined && snapshot.sessionId !== sessionId(ctx))
      return streaming
        ? portableError(403, 'forbidden', false)
        : new Response('Forbidden', { status: 403 });
    // The action URL names a view definition while the request body names a
    // mounted instance. Without this check either transport could run one
    // view's action against another view's snapshot.
    if (snapshot.view !== viewName)
      return streaming
        ? portableError(404, 'action_not_found', false)
        : new Response('Not Found', { status: 404 });
    const rid = `${requestVersion}:${nonce}`;
    if (snapshot.applied.some((entry) => entry.rid === rid && entry.action === name)) {
      return streaming
        ? sseResponse([
            {
              event: 'ui',
              data: { version: 1, kind: 'close' },
              id: String(snapshot.version),
            },
          ])
        : redirectBack(ctx);
    }
    if (requestVersion !== snapshot.version && action.stale !== 'rebase')
      return streaming
        ? portableError(409, 'stale_revision', true)
        : new Response('Conflict', { status: 409 });
    const state = serverView.def.state();
    hydrate(state, snapshot.data);
    try {
      await serverView.def.derive?.({ state, http: ctx, snapshot });
    } catch (error) {
      topic('fino:ui/render:error').publish(error);
      return streaming
        ? portableError(500, 'action_failed', true)
        : new Response('Internal Server Error', { status: 500 });
    }
    if (form !== null) {
      try {
        hydrate(state, embeddedEntries(form, serverView, options.secret));
      } catch (err) {
        return streaming
          ? portableError(400, 'invalid_input', true)
          : new Response((err as Error).message, { status: 400 });
      }
    }
    if (action.input !== undefined) {
      try {
        input = parseSchema(action.input, input);
      } catch {
        return streaming
          ? portableError(400, 'invalid_input', true)
          : new Response('Invalid action input', { status: 400 });
      }
    }
    let currentSnapshot = snapshot;
    const commit = async (complete: boolean) => {
      const data = serverView.persisted(state);
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
        streaming,
      );
      nextSnapshot.regions = { [viewId]: rendered.hash };
      await saveViewState(options.store, nextSnapshot, {
        expectVersion: currentSnapshot.version,
      });
      currentSnapshot = nextSnapshot;
      topic(`fino:ui/view:${viewId}`).publish({ version: nextVersion });
      return rendered;
    };
    try {
      await batch(() =>
        action.handler(
          {
            state,
            snapshot,
            http: ctx,
            checkpoint: () => commit(false).then(() => {}),
          },
          input,
        ),
      );
      const rendered = await commit(true);
      if (!streaming) return redirectBack(ctx);
      return sseResponse([
        {
          event: 'ui',
          data: {
            version: 1,
            kind: 'render',
            view: serverView.def.id,
            viewId,
            revision: currentSnapshot.version,
            tree: rendered.tree,
          },
          id: String(currentSnapshot.version),
        },
        {
          event: 'ui',
          data: { version: 1, kind: 'close' },
        },
      ]);
    } catch (error) {
      topic('fino:ui/action:error').publish({
        error,
        view: serverView.def.id,
        viewId,
        action: name,
      });
      if (error instanceof ViewActionError) {
        return streaming
          ? portableError(error.status, error.code, error.recoverable)
          : new Response(error.code, { status: error.status });
      }
      if (streaming) return portableError(500, 'action_failed', true);
      throw error;
    }
  });
}
async function renderLiveEvent(
  ctx: HttpContext,
  options: WebUIOptions,
  snapshot: ViewSnapshot,
  pagePath: string,
): Promise<PortableRenderEvent | null> {
  const serverView = views.get(snapshot.view);
  if (serverView === undefined) return null;
  const state = serverView.def.state();
  hydrate(state, snapshot.data);
  await serverView.def.derive?.({ state, http: ctx, snapshot });
  const nonce = randomId('render');
  const csrf = csrfPayload(snapshot.viewId, nonce, options.secret);
  const rendered = serverView.renderSnapshot(
    ctx,
    snapshot,
    state,
    nonce,
    csrf,
    options.secret,
    true,
    pagePath,
  );
  return {
    version: 1,
    kind: 'render',
    viewId: snapshot.viewId,
    tree: rendered.tree,
    view: serverView.def.id,
    revision: snapshot.version,
  };
}
function liveResponse(
  ctx: HttpContext,
  options: WebUIOptions,
  viewIds: string[],
  pagePath: string,
  initial?: PortableRenderEvent[],
): Response {
  const sendSnapshot = async (
    controller: ReadableStreamDefaultController<Uint8Array>,
    viewId: string,
  ) => {
    const snapshot = await loadViewState(options.store, viewId);
    if (
      snapshot === null ||
      (snapshot.sessionId !== undefined && snapshot.sessionId !== sessionId(ctx))
    ) {
      writeSse(controller, {
        event: 'ui',
        data: {
          version: 1,
          kind: 'navigate',
          url: pagePath,
          replace: true,
        },
      });
      return;
    }
    const render = await renderLiveEvent(ctx, options, snapshot, pagePath);
    if (render !== null)
      writeSse(controller, {
        event: 'ui',
        data: render,
        id: String(render.revision),
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
    async start(controller) {
      handles = viewIds.map((viewId) =>
        topic(`fino:ui/view:${viewId}`).subscribe(() => {
          void sendSnapshot(controller, viewId).catch(() => {});
        }),
      );
      if (initial === undefined) {
        for (const viewId of viewIds) await sendSnapshot(controller, viewId);
      } else {
        for (const render of initial) {
          writeSse(controller, {
            event: 'ui',
            data: render,
            id: String(render.revision),
          });
        }
      }
    },
    cancel: dispose,
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}
function handleLive(ctx: HttpContext, options: WebUIOptions): Response {
  const liveUrl = new URL(ctx.request.url);
  const viewsParam = liveUrl.searchParams.get('view') ?? '';
  const viewIds = viewsParam
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (viewIds.length === 0) return new Response('Missing view', { status: 400 });
  const referer = ctx.request.headers.get('referer');
  const pagePath =
    liveUrl.searchParams.get('url') ??
    (referer === null ? '/' : `${new URL(referer).pathname}${new URL(referer).search}`);
  return liveResponse(ctx, options, viewIds, pagePath);
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
        const deleted = await sweepViewState(options.store, now);
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
 * Create a page route handler that returns HTML or a live JSON UI stream.
 */
export function page(render: (ctx: HttpContext) => VNode): Handler {
  return async (ctx) => {
    const options = ctx.__finoUI as WebUIOptions | undefined;
    if (options === undefined) throw new Error('page() requires webUI() middleware');
    const env: RenderEnv = {
      ctx,
      options,
      streaming: wantsSse(ctx),
      mounts: [],
      csrfCookies: [],
      pending: [],
    };
    currentRender = env;
    try {
      let rendered: VNode;
      try {
        rendered = render(ctx);
      } catch (error) {
        if (!env.streaming) throw error;
        topic('fino:ui/render:error').publish(error);
        return portableError(500, 'invalid_tree', false);
      }
      await Promise.all(env.pending);
      const url = pageUrl(ctx);
      const res = env.streaming
        ? liveResponse(
            ctx,
            options,
            env.mounts.map((mount) => mount.viewId),
            `${url.pathname}${url.search}`,
            env.mounts,
          )
        : new Response('<!doctype html>' + renderToHtml(rendered), {
            headers: { 'content-type': 'text/html; charset=utf-8' },
          });
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
