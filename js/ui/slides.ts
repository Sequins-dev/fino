/**
 * fino:ui/slides — shared, server-driven presentations from MDX and Fino VNodes.
 *
 * A `Presentation` owns one default in-memory navigation state shared by its
 * presenter and following viewers, plus isolated viewer sessions requested
 * with `?follow=false`. It exposes mountable `Router` collections instead of
 * choosing application paths: `viewer()` and `presenter()` can be mounted
 * independently, while `router()` provides a convenience composition with the
 * presenter at the relative `/_presenter` route. The presenter is intentionally
 * unauthenticated at this layer so applications can attach their own middleware
 * before mount.
 *
 * Navigation is serialized on the server. By default, each accepted presenter
 * command renders one revision and fans the same `{ id, mode, html }` SSE patch
 * out to every connected viewer. Opening a viewer with `?follow=false` creates
 * an isolated server-side navigation session instead: arrow keys command that
 * session and its own SSE stream without changing presenter state. All session
 * state is process-local and resets with the application.
 *
 * MDX and component modules are trusted executable code. Components must be
 * synchronous server-rendered Fino UI components; browser hydration and
 * arbitrary client action registration are outside this module.
 *
 * ```ts no_run
 * import { App } from 'fino:net/http/app';
 * import { Presentation } from 'fino:ui/slides';
 *
 * const slides = new Presentation('./talk.mdx');
 * const app = new App();
 * app.route('/talk').mount(slides.viewer());
 * app.route('/talk-control').use(requireUser).mount(slides.presenter());
 * // `/talk` follows the presenter; `/talk?follow=false` navigates independently.
 * ```
 */
import { topic, type Topic } from 'fino:context/topic';
import { Router } from 'fino:net/http/app';
import { Watcher } from 'fino:file/watch';
import { resolve as resolvePath } from 'fino:file/path';
import { cwd } from 'fino:process';
import { Realm } from 'fino:realm';
import { escapeHtml } from 'fino:template';
import { Fragment, h, type Child, type Component, type NormalizedChild, type VNode } from 'fino:ui';
import { renderToHtml } from 'fino:ui/html';
/** Metadata optionally exported by a slide module. */
export interface PresentationMeta {
  /** Browser and presenter title. */
  title?: string;
  /** Presenter or organization label. */
  author?: string;
  /** Document language. Defaults to `en`. */
  lang?: string;
}
/** CSS-variable theme optionally exported by a slide module. */
export type PresentationTheme = Record<string, string | number>;
/** Executable module consumed by `Presentation`. */
export interface PresentationModule {
  /** Render the complete deck as slide `<section>` VNodes. */
  default: (props?: { components?: Record<string, string | Component<any>> }) => VNode;
  /** Optional document metadata. */
  meta?: PresentationMeta;
  /** Optional CSS variables applied to viewer and presenter pages. */
  theme?: PresentationTheme;
  /** Optional Markdown element and deck primitive overrides. */
  components?: Record<string, string | Component<any>>;
}
/** Construction options for a shared presentation. */
export interface PresentationOptions {
  /** Stable identifier used to isolate the presentation broadcast topic. */
  id?: string;
}
/** Immutable snapshot of shared navigation state. */
export interface PresentationState {
  /** Zero-based active slide index. */
  slide: number;
  /** Zero-based revealed step within the active slide. */
  step: number;
  /** Monotonically increasing accepted-command revision. */
  revision: number;
}
interface SlideRecord {
  vnode: VNode;
  notes: string;
  maxStep: number;
}
interface Manifest {
  slides: SlideRecord[];
  meta: PresentationMeta;
  theme: PresentationTheme;
}
interface Patch {
  id: string;
  mode: 'inner';
  html: string;
}
interface Broadcast {
  revision: number;
  viewer: Patch;
  presenter: Patch;
  closed?: boolean;
}
interface ViewerBroadcast {
  revision: number;
  viewer: Patch;
  closed?: boolean;
}
interface ViewerSession {
  id: string;
  nonce: string;
  state: PresentationState;
  queue: Promise<void>;
  updates: Topic<ViewerBroadcast>;
  current: ViewerBroadcast;
}
let nextPresentationId = 1;
const maxIndependentViewerSessions = 128;
/** Mark presenter-only speaker notes that are removed from audience output. */
function Notes(props: { children?: NormalizedChild[] }): VNode {
  return h(
    'aside',
    {
      'data-fino-notes': true,
      hidden: true,
    },
    props.children ?? [],
  );
}
/** Mark document-level head content that is not rendered inside a slide. */
function Head(props: { children?: NormalizedChild[] }): VNode {
  return h(
    'div',
    {
      'data-fino-head': true,
      hidden: true,
    },
    props.children ?? [],
  );
}
/** Render repeated slide header content using the theme's header placement. */
function Header(props: { children?: NormalizedChild[] }): VNode {
  return h('header', { class: 'fino-slide-header' }, props.children ?? []);
}
/** Render repeated slide footer content using the theme's footer placement. */
function Footer(props: { children?: NormalizedChild[] }): VNode {
  return h('footer', { class: 'fino-slide-footer' }, props.children ?? []);
}
/** Reveal direct children sequentially before navigation advances the slide. */
function Steps(props: { children?: NormalizedChild[] }): VNode {
  return h('div', { 'data-fino-steps': true }, props.children ?? []);
}
const deckComponents: Record<string, Component<any>> = {
  Notes,
  Head,
  Header,
  Footer,
  Steps,
};
function isVNode(value: NormalizedChild): value is VNode {
  return typeof value !== 'string';
}
function walk(node: VNode, fn: (node: VNode) => void): void {
  fn(node);
  for (const child of node.children) if (isVNode(child)) walk(child, fn);
}
function renderChildren(children: NormalizedChild[]): string {
  return children
    .map((child) => (typeof child === 'string' ? escapeHtml(child) : renderToHtml(child)))
    .join('');
}
function slideRecord(vnode: VNode): SlideRecord {
  let notes = '';
  let maxStep = 0;
  walk(vnode, (node) => {
    if (node.props['data-fino-notes'] === true) notes += renderChildren(node.children);
    if (node.props['data-fino-steps'] === true)
      maxStep = Math.max(maxStep, node.children.length - 1);
  });
  return {
    vnode,
    notes,
    maxStep,
  };
}
function audienceNode(node: VNode, step: number): VNode | null {
  if (node.props['data-fino-notes'] === true || node.props['data-fino-head'] === true) return null;
  const source =
    node.props['data-fino-steps'] === true ? node.children.slice(0, step + 1) : node.children;
  const children: Child[] = [];
  for (const child of source) {
    if (typeof child === 'string') children.push(child);
    else {
      const next = audienceNode(child, step);
      if (next) children.push(next);
    }
  }
  return h(node.type, { ...node.props }, children);
}
function slideSections(root: VNode): VNode[] {
  const candidates = root.type === 'fragment' ? root.children.filter(isVNode) : [root];
  return candidates.filter(
    (node) => node.type === 'section' && node.props['data-fino-slide'] !== undefined,
  );
}
function themeStyle(theme: PresentationTheme): string {
  return Object.entries(theme)
    .map(([name, value]) => {
      const property = name.startsWith('--')
        ? name
        : `--slides-${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`;
      return `${property}:${String(value)}`;
    })
    .join(';');
}
function slideSurface(frame: string): string {
  return `<div class="fino-slide-surface">${frame}</div>`;
}
function advanceState(state: PresentationState, slides: SlideRecord[]): void {
  const current = slides[state.slide]!;
  if (state.step < current.maxStep) state.step++;
  else if (state.slide < slides.length - 1) {
    state.slide++;
    state.step = 0;
  }
}
function retreatState(state: PresentationState): void {
  if (state.step > 0) state.step--;
  else if (state.slide > 0) {
    state.slide--;
    state.step = 0;
  }
}
function originRejection(request: Request): Response | null {
  const unsafeRequest = request as unknown as {
    _getUnsafeHeader?: (name: string) => string | null;
  };
  const fetchSite =
    request.headers.get('sec-fetch-site') ??
    unsafeRequest._getUnsafeHeader?.('sec-fetch-site') ??
    null;
  if (
    fetchSite !== null &&
    fetchSite !== 'same-origin' &&
    fetchSite !== 'same-site' &&
    fetchSite !== 'none'
  )
    return new Response('Forbidden: origin', { status: 403 });
  const requestOrigin =
    request.headers.get('origin') ?? unsafeRequest._getUnsafeHeader?.('origin') ?? null;
  if (requestOrigin !== null && new URL(requestOrigin).origin !== new URL(request.url).origin)
    return new Response('Forbidden: origin', { status: 403 });
  return null;
}
function pageShell(
  title: string,
  lang: string,
  body: string,
  style: string,
  script: string,
): Response {
  return new Response(
    `<!doctype html><html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>${style}</style></head><body>${body}<script>${script}<\/script></body></html>`,
    { headers: { 'content-type': 'text/html; charset=utf-8' } },
  );
}
const sharedStyle = `
:root{--slides-paper:#f1eadc;--slides-ink:#171713;--slides-accent:#e4542f;--slides-muted:#8e877a;--slides-panel:#24231f;color-scheme:light}
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:var(--slides-ink);color:var(--slides-ink)}
body{font-family:"Avenir Next Condensed","Helvetica Neue",sans-serif}.fino-slide-viewport{position:relative;display:grid;place-items:center;overflow:hidden;container-type:size}.fino-slide-surface{width:min(100cqw,177.7777778cqh);height:min(100cqh,56.25cqw);aspect-ratio:16/9;container-type:inline-size}.fino-slide-frame{position:relative;width:100%;height:100%;font-size:1.25cqw;overflow:hidden;background:var(--slides-paper);color:var(--slides-ink);box-shadow:0 2.5em 8em #0009;isolation:isolate;container-type:inline-size}
.fino-slide-frame:before{content:"";position:absolute;inset:0;z-index:-1;opacity:.2;background-image:radial-gradient(#171713 .034375em,transparent .034375em);background-size:.3125em .3125em}
.fino-slide-frame>section{width:100%;height:100%;padding:8% 9%;display:flex;flex-direction:column;justify-content:center;gap:1.3em}
.fino-slide-frame h1,.fino-slide-frame h2,.fino-slide-frame h3{font-family:"Iowan Old Style","Baskerville",serif;line-height:.93;letter-spacing:-.045em;margin:0;max-width:100%}
.fino-slide-frame h1{font-size:5.5cqw}.fino-slide-frame h2{font-size:4.6cqw}.fino-slide-frame h3{font-size:3.4cqw}
.fino-slide-frame p,.fino-slide-frame li{font-size:2.5cqw;line-height:1.38;max-width:34em}.fino-slide-frame p:empty{display:none}.fino-slide-frame a{color:var(--slides-accent)}
.fino-slide-frame code{font-family:"SFMono-Regular",monospace;background:#17171312;padding:.08em .25em}.fino-slide-frame pre{padding:1.5em;background:var(--slides-ink);color:var(--slides-paper);overflow:auto}
.fino-slide-frame blockquote{margin:0;border-left:.35em solid var(--slides-accent);padding-left:1.5em}.fino-slide-header,.fino-slide-footer{position:absolute;left:4%;right:4%;font-size:.78em;letter-spacing:.15em;text-transform:uppercase}.fino-slide-header{top:3%}.fino-slide-footer{bottom:3%}
.fino-progress{position:absolute;inset:auto 0 0;height:.34em;background:#1717131c}.fino-progress>i{display:block;height:100%;background:var(--slides-accent);transition:width .35s ease}
button,select{font:inherit}button{cursor:pointer}
`;
const viewerStyle = `${sharedStyle}
body{position:relative;display:grid;place-items:center;width:100vw;height:100vh;overflow:hidden}.fino-audience{width:100vw;height:100vh;animation:enter .55s cubic-bezier(.2,.8,.2,1)}
.fino-fullscreen{position:absolute;right:0;top:0;border:1px solid #f1eadc55;background:#171713aa;color:var(--slides-paper);padding:1rem 1.15rem;letter-spacing:.09em;text-transform:uppercase;font-size:.68rem;opacity:0;transition:opacity .18s ease}.fino-fullscreen:hover,.fino-fullscreen:focus-visible{opacity:1}
@keyframes enter{from{opacity:0;transform:translateY(1rem) scale(.99)}}
`;
const presenterStyle = `${sharedStyle}
body{background:#191917;color:var(--slides-paper);min-height:100vh}.fino-presenter-shell{height:100vh;min-height:0;padding:2rem;display:grid;grid-template-columns:minmax(0,1.6fr) minmax(18rem,.7fr);gap:2rem}
.fino-presenter-main{display:grid;grid-template-rows:auto minmax(0,1fr) auto;gap:1rem;min-width:0;min-height:0}.fino-presenter-kicker{margin:0;color:var(--slides-accent);font-size:.72rem;letter-spacing:.22em;text-transform:uppercase}.fino-presenter-title{font:2rem/1 "Iowan Old Style",serif;margin:.3rem 0 0}
.fino-presenter-preview{width:100%;height:100%;min-width:0;min-height:0}.fino-presenter-controls{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;gap:.6rem;align-items:center;min-width:0}
.fino-presenter-controls button,.fino-presenter-controls select{border:1px solid #f1eadc33;background:#24231f;color:var(--slides-paper);padding:.8rem 1rem}.fino-presenter-controls button:hover{border-color:var(--slides-accent);color:var(--slides-accent)}
.fino-compile-error{margin:0;padding:1rem 2rem;background:#8d241d;color:#fff4e8;border-bottom:1px solid #ffb39b}.fino-compile-error strong{letter-spacing:.08em;text-transform:uppercase;font-size:.74rem}.fino-compile-error pre{margin:.5rem 0 0;white-space:pre-wrap;font:12px/1.45 "SFMono-Regular",monospace}
.fino-presenter-side{display:grid;grid-template-rows:auto auto minmax(0,1fr);gap:1rem;min-width:0;min-height:0}.fino-clock{font:3rem/1 "Iowan Old Style",serif;font-variant-numeric:tabular-nums}.fino-next{opacity:.72;min-width:0;overflow:hidden}.fino-next-viewport{width:100%;aspect-ratio:16/9}.fino-notes{border-top:1px solid #f1eadc22;padding-top:1rem;overflow:auto;line-height:1.55;color:#d8d0c2}.fino-notes h3{color:var(--slides-accent);font-size:.72rem;letter-spacing:.18em;text-transform:uppercase}
@media(max-width:900px){.fino-presenter-shell{height:auto;min-height:100vh;grid-template-columns:1fr}.fino-presenter-main{grid-template-rows:auto auto auto}.fino-presenter-preview{height:auto;aspect-ratio:16/9}.fino-presenter-controls{grid-template-columns:1fr 1fr}.fino-presenter-side{grid-template-rows:auto auto auto}}
`;
const patchClient = `
function applyPatch(event){const patch=JSON.parse(event.data);const target=document.getElementById(patch.id);if(!target)return;if(patch.mode==='inner')target.innerHTML=patch.html;}
`;
/**
 * Shared server-side presentation and route factory.
 *
 * `source` may be a module object or an importable `.mdx`/`.tsx` path. Loading
 * begins immediately and handlers await it before rendering. Call `close()` to
 * end active event streams and release the presentation.
 */
export class Presentation {
  #source: string | PresentationModule;
  #manifest!: Manifest;
  #ready: Promise<void>;
  #state: PresentationState = {
    slide: 0,
    step: 0,
    revision: 0,
  };
  #queue: Promise<void> = Promise.resolve();
  #updates: Topic<Broadcast>;
  #current!: Broadcast;
  #viewerSessions = new Map<string, ViewerSession>();
  #nonce = crypto.randomUUID();
  #startedAt = Date.now();
  #closed = false;
  #watcher: Watcher | null = null;
  #watchTask: Promise<void> | null = null;
  #diagnostic = '';
  /** Begin loading `source` and create the default shared presentation session. */
  constructor(source: string | PresentationModule, options: PresentationOptions = {}) {
    this.#source = source;
    const id = options.id ?? `presentation-${nextPresentationId++}-${crypto.randomUUID()}`;
    this.#updates = topic<Broadcast>(`fino:ui/slides:${id}`);
    this.#ready = this.#load();
  }
  /** Current navigation snapshot. A fresh object is returned on every read. */
  get state(): PresentationState {
    return { ...this.#state };
  }
  async #load(): Promise<void> {
    if (typeof this.#source === 'string') {
      const filename = this.#filename(this.#source);
      const loaded = await this.#evaluateFile(filename);
      this.#install(loaded.vnode, loaded.meta, loaded.theme);
      this.#current = this.#renderBroadcast();
      this.#watchTask = this.#watch(filename);
      return;
    }
    const module = this.#source;
    const rendered = module.default({
      components: {
        ...deckComponents,
        ...(module.components ?? {}),
      },
    });
    if (!rendered || typeof rendered !== 'object' || typeof rendered.type !== 'string')
      throw new TypeError('Presentation module default export must return a Fino VNode');
    this.#install(rendered, module.meta ?? {}, module.theme ?? {});
    this.#current = this.#renderBroadcast();
  }
  #filename(specifier: string): string {
    if (specifier.startsWith('/')) return specifier;
    if (specifier.startsWith('file://')) return decodeURIComponent(new URL(specifier).pathname);
    return resolvePath(cwd(), specifier).toString();
  }
  async #evaluateFile(filename: string): Promise<{
    vnode: VNode;
    meta: PresentationMeta;
    theme: PresentationTheme;
  }> {
    const wrapper = `
      import Deck, * as deckModule from ${JSON.stringify(filename)};
      export default function renderPresentationModule() {
        return { vnode: Deck(), meta: deckModule.meta ?? {}, theme: deckModule.theme ?? {} };
      }
    `;
    const realm = Realm.fromSource<
      () => {
        vnode: VNode;
        meta: PresentationMeta;
        theme: PresentationTheme;
      }
    >(wrapper);
    try {
      const loaded = await realm.call();
      if (!loaded?.vnode || typeof loaded.vnode.type !== 'string')
        throw new TypeError('Presentation module default export must return a Fino VNode');
      return loaded;
    } finally {
      realm.terminate();
    }
  }
  #install(rendered: VNode, meta: PresentationMeta, theme: PresentationTheme): void {
    const slides = slideSections(rendered).map(slideRecord);
    if (slides.length === 0)
      throw new Error('Presentation module did not render any <section data-fino-slide> elements');
    this.#manifest = {
      slides,
      meta,
      theme,
    };
    this.#clampState(this.#state);
    for (const session of this.#viewerSessions.values()) this.#clampState(session.state);
  }
  #clampState(state: PresentationState): void {
    state.slide = Math.min(state.slide, this.#manifest.slides.length - 1);
    state.step = Math.min(state.step, this.#manifest.slides[state.slide]!.maxStep);
  }
  async #watch(filename: string): Promise<void> {
    const slash = filename.lastIndexOf('/');
    const directory = slash > 0 ? filename.slice(0, slash) : '.';
    const watcher = new Watcher({ recursive: true });
    this.#watcher = watcher;
    watcher.watch(directory);
    watcher.watch(filename);
    try {
      for await (const event of watcher) {
        if (this.#closed) break;
        if (event.path !== directory && !/\.(?:mdx|tsx?|jsx?|json)$/i.test(event.path)) continue;
        await new Promise<void>((resolve) => setTimeout(resolve, 60));
        try {
          const loaded = await this.#evaluateFile(filename);
          this.#install(loaded.vnode, loaded.meta, loaded.theme);
          this.#diagnostic = '';
        } catch (error) {
          this.#diagnostic = error instanceof Error ? error.message : String(error);
        }
        this.#state.revision++;
        this.#current = this.#renderBroadcast();
        this.#updates.publish(this.#current);
        for (const session of this.#viewerSessions.values()) {
          session.state.revision++;
          session.current = this.#renderViewerBroadcast(session.state);
          session.updates.publish(session.current);
        }
      }
    } finally {
      if (this.#watcher === watcher) this.#watcher = null;
      watcher.close();
    }
  }
  #audienceHtml(state: PresentationState): string {
    const record = this.#manifest.slides[state.slide]!;
    const vnode = audienceNode(record.vnode, state.step)!;
    const progress = ((state.slide + 1) / this.#manifest.slides.length) * 100;
    const frame = `<div class="fino-slide-frame" style="${escapeHtml(themeStyle(this.#manifest.theme))}">${renderToHtml(vnode)}<div class="fino-progress" role="progressbar" aria-valuemin="1" aria-valuemax="${this.#manifest.slides.length}" aria-valuenow="${state.slide + 1}"><i style="width:${progress}%"></i></div></div>`;
    return slideSurface(frame);
  }
  #presenterHtml(audience: string): string {
    const current = this.#manifest.slides[this.#state.slide]!;
    const next = this.#manifest.slides[this.#state.slide + 1];
    const nextHtml = next
      ? renderToHtml(audienceNode(next.vnode, 0)!)
      : '<section><p>End of deck</p></section>';
    const options = this.#manifest.slides
      .map(
        (_, index) =>
          `<option value="go:${index}"${index === this.#state.slide ? ' selected' : ''}>${String(index + 1).padStart(2, '0')}</option>`,
      )
      .join('');
    const failure = this.#diagnostic
      ? `<div class="fino-compile-error" role="alert"><strong>Deck compile failed — showing last good revision</strong><pre>${escapeHtml(this.#diagnostic)}</pre></div>`
      : '';
    const nextFrame = `<div class="fino-slide-frame" style="${escapeHtml(themeStyle(this.#manifest.theme))}">${nextHtml}</div>`;
    return `${failure}<div class="fino-presenter-shell" data-presentation-nonce="${escapeHtml(this.#nonce)}" data-started-at="${this.#startedAt}"><section class="fino-presenter-main"><header><p class="fino-presenter-kicker">Presenter · ${this.#state.slide + 1}/${this.#manifest.slides.length} · step ${this.#state.step + 1}</p><h1 class="fino-presenter-title">${escapeHtml(this.#manifest.meta.title ?? 'Untitled presentation')}</h1></header><div class="fino-presenter-preview fino-slide-viewport">${audience}</div><nav class="fino-presenter-controls" aria-label="Presentation controls"><button data-command="previous" aria-label="Previous slide">← Previous</button><button data-command="next" aria-label="Next slide or step">Next →</button><select data-slide-picker aria-label="Choose slide">${options}</select><button data-fullscreen>Fullscreen</button></nav></section><aside class="fino-presenter-side"><div><p class="fino-presenter-kicker">Elapsed</p><div class="fino-clock" data-clock>00:00</div></div><div class="fino-next"><p class="fino-presenter-kicker">Next</p><div class="fino-next-viewport fino-slide-viewport">${slideSurface(nextFrame)}</div></div><div class="fino-notes"><h3>Notes</h3>${current.notes || '<p>No notes for this slide.</p>'}</div></aside></div>`;
  }
  #renderBroadcast(): Broadcast {
    const audience = this.#audienceHtml(this.#state);
    return {
      revision: this.#state.revision,
      viewer: {
        id: 'fino-slides-stage',
        mode: 'inner',
        html: audience,
      },
      presenter: {
        id: 'fino-slides-presenter',
        mode: 'inner',
        html: this.#presenterHtml(audience),
      },
    };
  }
  #renderViewerBroadcast(state: PresentationState): ViewerBroadcast {
    return {
      revision: state.revision,
      viewer: {
        id: 'fino-slides-stage',
        mode: 'inner',
        html: this.#audienceHtml(state),
      },
    };
  }
  #createViewerSession(): ViewerSession {
    if (this.#viewerSessions.size >= maxIndependentViewerSessions) {
      const oldest = this.#viewerSessions.values().next().value as ViewerSession;
      oldest.updates.publish({
        ...oldest.current,
        closed: true,
      });
      this.#viewerSessions.delete(oldest.id);
    }
    const id = crypto.randomUUID();
    const state: PresentationState = {
      slide: 0,
      step: 0,
      revision: 0,
    };
    const session: ViewerSession = {
      id,
      nonce: crypto.randomUUID(),
      state,
      queue: Promise.resolve(),
      updates: topic<ViewerBroadcast>(`fino:ui/slides:viewer:${id}`),
      current: this.#renderViewerBroadcast(state),
    };
    this.#viewerSessions.set(id, session);
    return session;
  }
  #transitionViewerSession(session: ViewerSession, change: () => void): Promise<void> {
    const run = async () => {
      await this.#ready;
      if (this.#closed || this.#viewerSessions.get(session.id) !== session)
        throw new Error('Viewer session is closed');
      change();
      session.state.revision++;
      session.current = this.#renderViewerBroadcast(session.state);
      session.updates.publish(session.current);
    };
    session.queue = session.queue.then(run, run);
    return session.queue;
  }
  async #transition(change: () => void): Promise<void> {
    const run = async () => {
      await this.#ready;
      if (this.#closed) throw new Error('Presentation is closed');
      change();
      this.#state.revision++;
      this.#current = this.#renderBroadcast();
      this.#updates.publish(this.#current);
    };
    this.#queue = this.#queue.then(run, run);
    return this.#queue;
  }
  /** Reveal the next step, or advance one slide when all steps are visible. */
  next(): Promise<void> {
    return this.#transition(() => advanceState(this.#state, this.#manifest.slides));
  }
  /** Move to the previous step, or to the preceding slide's first step. */
  previous(): Promise<void> {
    return this.#transition(() => retreatState(this.#state));
  }
  /** Move to a zero-based slide and optional step, clamped to deck bounds. */
  goTo(index: number, step = 0): Promise<void> {
    return this.#transition(() => {
      const slide = Math.max(0, Math.min(this.#manifest.slides.length - 1, Math.trunc(index)));
      this.#state.slide = slide;
      this.#state.step = Math.max(
        0,
        Math.min(this.#manifest.slides[slide]!.maxStep, Math.trunc(step)),
      );
    });
  }
  /** Return to the first slide and restart the presenter timer. */
  reset(): Promise<void> {
    return this.#transition(() => {
      this.#state.slide = 0;
      this.#state.step = 0;
      this.#startedAt = Date.now();
    });
  }
  async #writeStream(events: any, kind: 'viewer' | 'presenter'): Promise<void> {
    await this.#ready;
    await events.write({
      event: 'patch',
      data: JSON.stringify(this.#current[kind]),
      id: String(this.#current.revision),
    });
    for await (const update of this.#updates) {
      if (update.closed) break;
      await events.write({
        event: 'patch',
        data: JSON.stringify(update[kind]),
        id: String(update.revision),
      });
    }
  }
  async #writeViewerSessionStream(events: any, session: ViewerSession): Promise<void> {
    await this.#ready;
    await events.write({
      event: 'patch',
      data: JSON.stringify(session.current.viewer),
      id: String(session.current.revision),
    });
    for await (const update of session.updates) {
      if (update.closed) break;
      await events.write({
        event: 'patch',
        data: JSON.stringify(update.viewer),
        id: String(update.revision),
      });
    }
  }
  #viewerPage(session?: ViewerSession): Response {
    const title = this.#manifest.meta.title ?? 'Presentation';
    const attributes = session
      ? ` data-fino-viewer-session="${escapeHtml(session.id)}" data-fino-viewer-nonce="${escapeHtml(session.nonce)}"`
      : '';
    const audience = session?.current.viewer.html ?? this.#current.viewer.html;
    const body = `<main id="fino-slides-stage" class="fino-slide-viewport fino-audience"${attributes}>${audience}</main><button class="fino-fullscreen" data-fullscreen aria-label="Enter fullscreen">Fullscreen</button>`;
    const script = session
      ? `${patchClient}
const root=document.getElementById('fino-slides-stage');const endpoint=location.pathname.replace(/\\/$/,'');const session=root.dataset.finoViewerSession;const nonce=root.dataset.finoViewerNonce;const stream=new EventSource(endpoint+'/_events?session='+encodeURIComponent(session));stream.addEventListener('patch',applyPatch);
async function send(command){const body=new URLSearchParams({command,session,nonce});await fetch(endpoint+'/_command',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});}
document.addEventListener('keydown',event=>{if(event.key==='ArrowRight'||event.key==='ArrowDown'){event.preventDefault();send('next');}else if(event.key==='ArrowLeft'||event.key==='ArrowUp'){event.preventDefault();send('previous');}});
document.querySelector('[data-fullscreen]').addEventListener('click',()=>document.documentElement.requestFullscreen?.());`
      : `${patchClient}const stream=new EventSource(location.pathname.replace(/\\/$/,'')+'/_events');stream.addEventListener('patch',applyPatch);document.querySelector('[data-fullscreen]').addEventListener('click',()=>document.documentElement.requestFullscreen?.());`;
    return pageShell(title, this.#manifest.meta.lang ?? 'en', body, viewerStyle, script);
  }
  #presenterPage(): Response {
    const title = `${this.#manifest.meta.title ?? 'Presentation'} · Presenter`;
    const body = `<main id="fino-slides-presenter">${this.#current.presenter.html}</main>`;
    const script = `${patchClient}
const root=document.getElementById('fino-slides-presenter');const endpoint=location.pathname.replace(/\\/$/,'');const stream=new EventSource(endpoint+'/_events');stream.addEventListener('patch',event=>{applyPatch(event);bind();});
async function send(command){const shell=root.querySelector('[data-presentation-nonce]');const body=new URLSearchParams({command,nonce:shell.dataset.presentationNonce});await fetch(endpoint+'/_command',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});}
function bind(){root.querySelectorAll('[data-command]').forEach(button=>button.onclick=()=>send(button.dataset.command));const picker=root.querySelector('[data-slide-picker]');if(picker)picker.onchange=()=>send(picker.value);const fullscreen=root.querySelector('[data-fullscreen]');if(fullscreen)fullscreen.onclick=()=>document.documentElement.requestFullscreen?.();}
document.addEventListener('keydown',event=>{if(event.key==='ArrowRight'||event.key==='PageDown'){event.preventDefault();send('next');}else if(event.key==='ArrowLeft'||event.key==='PageUp'){event.preventDefault();send('previous');}else if(event.key==='Home'){event.preventDefault();send('reset');}});
let touch=0;document.addEventListener('touchstart',event=>{touch=event.changedTouches[0].clientX},{passive:true});document.addEventListener('touchend',event=>{const delta=event.changedTouches[0].clientX-touch;if(Math.abs(delta)>45)send(delta<0?'next':'previous')},{passive:true});
setInterval(()=>{const shell=root.querySelector('[data-started-at]');const clock=root.querySelector('[data-clock]');if(!shell||!clock)return;const seconds=Math.max(0,Math.floor((Date.now()-Number(shell.dataset.startedAt))/1000));clock.textContent=String(Math.floor(seconds/60)).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0');},1000);bind();`;
    return pageShell(title, this.#manifest.meta.lang ?? 'en', body, presenterStyle, script);
  }
  /**
   * Create the audience router and its SSE endpoints.
   *
   * The default page follows presenter state. A request with `?follow=false`
   * allocates an isolated server-side session, starts it at the first slide,
   * and emits arrow-key commands over `POST /_command`. Independent sessions
   * still receive rendered patches over SSE and are capped at 128 per
   * `Presentation`; creating another closes the oldest session.
   */
  viewer(): Router {
    const router = new Router();
    router.get('/').handle(async (ctx) => {
      await this.#ready;
      const independent = new URL(ctx.request.url).searchParams.get('follow') === 'false';
      return this.#viewerPage(independent ? this.#createViewerSession() : undefined);
    });
    router.post('/_command').handle(async (ctx) => {
      const rejected = originRejection(ctx.request);
      if (rejected) return rejected;
      const form = await ctx.request.formData();
      const session = this.#viewerSessions.get(String(form.get('session') ?? ''));
      if (!session) return new Response('Viewer session not found', { status: 404 });
      if (String(form.get('nonce') ?? '') !== session.nonce)
        return new Response('Forbidden: nonce', { status: 403 });
      const command = String(form.get('command') ?? '');
      if (command === 'next')
        await this.#transitionViewerSession(session, () =>
          advanceState(session.state, this.#manifest.slides),
        );
      else if (command === 'previous')
        await this.#transitionViewerSession(session, () => retreatState(session.state));
      else return new Response('Bad Request', { status: 400 });
      return Response.json({ ...session.state });
    });
    router.route('/_events').sse((events, ctx) => {
      const id = new URL(ctx.request.url).searchParams.get('session');
      if (id === null) return this.#writeStream(events, 'viewer');
      const session = this.#viewerSessions.get(id);
      if (!session) throw new Error('Viewer session not found');
      return this.#writeViewerSessionStream(events, session);
    });
    return router;
  }
  /** Create a router serving the presenter console, command endpoint, and SSE stream. */
  presenter(): Router {
    const router = new Router();
    router.get('/').handle(async () => {
      await this.#ready;
      return this.#presenterPage();
    });
    router.post('/_command').handle(async (ctx) => {
      const rejected = originRejection(ctx.request);
      if (rejected) return rejected;
      const form = await ctx.request.formData();
      if (String(form.get('nonce') ?? '') !== this.#nonce)
        return new Response('Forbidden: nonce', { status: 403 });
      const command = String(form.get('command') ?? '');
      if (command === 'next') await this.next();
      else if (command === 'previous') await this.previous();
      else if (command === 'reset') await this.reset();
      else if (command.startsWith('go:')) await this.goTo(Number(command.slice(3)));
      else return new Response('Bad Request', { status: 400 });
      return Response.json(this.state);
    });
    router.route('/_events').sse((events) => this.#writeStream(events, 'presenter'));
    return router;
  }
  /**
   * Create the convenience router: viewer at `/`, presenter at the relative
   * `/_presenter` branch. Use split routers when authentication or unrelated
   * public paths are required.
   */
  router(): Router {
    const router = new Router();
    router.route('/').mount(this.viewer());
    router.route('/_presenter').mount(this.presenter());
    return router;
  }
  /** End active streams and reject future navigation commands. Idempotent. */
  async close(): Promise<void> {
    await this.#ready;
    if (this.#closed) return;
    this.#closed = true;
    this.#watcher?.close();
    this.#updates.publish({
      ...this.#current,
      closed: true,
    });
    for (const session of this.#viewerSessions.values())
      session.updates.publish({
        ...session.current,
        closed: true,
      });
    this.#viewerSessions.clear();
    await this.#watchTask;
  }
  /** Dispose the presentation with `await using`. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
export { Footer, Head, Header, Notes, Steps };
