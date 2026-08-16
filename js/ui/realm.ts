/**
 * fino:ui/realm — render components in an isolated realm.
 *
 * A component is a synchronous function, so a tree that depends on data which
 * has not loaded yet cannot wait for it. This module resolves that without
 * making components async: the component runs inside a child realm alongside
 * whatever asynchronous work feeds its signals, republishes its tree on every
 * revision, and the realm's own event loop decides when there is nothing left
 * to render. Draining is completion — the render resolves with the last tree
 * the child published before it exited.
 *
 * A realm is held open by pending work, not by an open port, so a rendering
 * child cannot idle indefinitely waiting to be asked for more. Render a whole
 * batch in one pass instead: `renderRealmAll()` spawns one isolate, sends the
 * shared data once, and returns a tree per item, which is what a build
 * producing many pages from one component wants anyway.
 *
 * Everything crossing the boundary is portable by construction, which is the
 * point: props are JSON going in, trees are `PortableVNode` coming back, and
 * the component cannot reach a host object on the parent side. A theme, a
 * plugin, or a page template is therefore untrusted input that renders under
 * whatever import rules the parent grants it.
 *
 * ```ts no_run
 * import { renderRealm } from 'fino:ui/realm';
 * import { renderToHtml } from 'fino:ui/html';
 *
 * const tree = await renderRealm('./page.tsx', { props: { title: 'Home' } });
 * const html = renderToHtml(tree);
 * ```
 */
import { Realm, type ImportMap, type ImportRule } from 'fino:realm';
import { resolve as resolvePath } from 'fino:file/path';
import { cwd } from 'fino:process';
import type { PortableValue, PortableVNode } from 'fino:ui/portable';

interface RenderMessage {
  kind: 'fino:ui/realm';
  revision: number;
  trees: PortableVNode[];
}

interface RenderErrorMessage {
  kind: 'fino:ui/realm:error';
  message: string;
}

type ChildMessage = RenderMessage | RenderErrorMessage;

/** Realm construction options shared by every rendering mode. */
export interface RealmRenderOptions {
  /**
   * Import rules granted to the rendering child.
   *
   * Realm defaults apply when omitted. Pass `ImportMap.deny([...])` to render a
   * component that should reach nothing beyond the modules it is granted.
   */
  overrides?: ImportMap | ImportRule[];
  /** Run the child in a separate OS process rather than on the reactor pool. */
  process?: boolean;
}

/** Options for rendering one component tree. */
export interface RenderRealmOptions extends RealmRenderOptions {
  /** Props passed to the component. Must be JSON data. */
  props?: PortableValue;
}

/** Options for rendering one component across many prop sets. */
export interface RenderRealmAllOptions extends RealmRenderOptions {
  /** Props merged into every item, sent to the child once. */
  shared?: Record<string, PortableValue>;
  /** Per-render props. One tree is returned per item, in order. */
  items: Array<Record<string, PortableValue>>;
}

/**
 * Resolve a component specifier to something the child can import.
 *
 * Built-in specifiers are passed through so a first-party component travels the
 * same path as a user's file, rather than getting a privileged shortcut that
 * would let it drift out of the portable contract.
 */
function moduleFilename(specifier: string): string {
  if (specifier.startsWith('fino:') || specifier.startsWith('internal:')) return specifier;
  if (specifier.startsWith('/')) return specifier;
  if (specifier.startsWith('file://')) return decodeURIComponent(new URL(specifier).pathname);
  return resolvePath(cwd(), specifier).toString();
}

function isChildMessage(value: unknown): value is ChildMessage {
  if (value === null || typeof value !== 'object') return false;
  const kind = (value as { kind?: unknown }).kind;
  return kind === 'fino:ui/realm' || kind === 'fino:ui/realm:error';
}

function childSource(
  entry: string,
  shared: Record<string, PortableValue>,
  items: Array<Record<string, PortableValue>>,
): string {
  return `
import Component from ${JSON.stringify(entry)};
import { effect } from 'fino:signals';
import { lowerTree } from 'fino:ui';
import { toPortable } from 'fino:ui/portable';
import { port } from 'fino:realm/self';

const shared = ${JSON.stringify(shared)};
const items = ${JSON.stringify(items)};
let revision = 0;

effect(() => {
  try {
    // Components are lowered here, in the child, because publishing is the
    // point at which the tree stops being code and becomes data. The target
    // name is deliberately one nothing registers against: every component
    // resolves to its own default, which is what a receiver routing by name
    // expects to be handed.
    const trees = items.map((item) =>
      toPortable(lowerTree(Component({ ...shared, ...item }), 'portable')),
    );
    port?.postMessage({ kind: 'fino:ui/realm', revision: revision++, trees });
  } catch (error) {
    port?.postMessage({
      kind: 'fino:ui/realm:error',
      message: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  }
});
`;
}

async function runRenderRealm(
  entry: string,
  shared: Record<string, PortableValue>,
  items: Array<Record<string, PortableValue>>,
  options: RealmRenderOptions,
): Promise<PortableVNode[]> {
  const realm = Realm.fromSource(childSource(moduleFilename(entry), shared, items), {
    overrides: options.overrides,
    process: options.process,
  });
  let latest: PortableVNode[] | null = null;
  let failure: string | null = null;
  const port = realm.port;
  port.addEventListener('message', (event) => {
    const message = (event as MessageEvent).data;
    if (!isChildMessage(message)) return;
    if (message.kind === 'fino:ui/realm:error') failure = message.message;
    else {
      failure = null;
      latest = message.trees;
    }
  });
  port.start();
  try {
    await realm.run();
  } finally {
    port.close();
    realm.terminate();
  }
  if (failure !== null) throw new Error(`fino:ui/realm — ${entry}: ${failure}`);
  if (latest === null) throw new Error(`fino:ui/realm — ${entry} exited without rendering`);
  return latest;
}

/**
 * Render a component module in a realm and resolve its final tree.
 *
 * The child republishes its tree on every revision and the last one wins, so a
 * component whose data resolves asynchronously converges without the component
 * itself ever awaiting. The promise resolves once the child's event loop drains
 * and it exits, so work that never settles never completes.
 *
 * Rejects when the child fails to load or evaluate, when the component throws,
 * and when the child exits without rendering at all.
 *
 * ```ts no_run
 * import { renderRealm } from 'fino:ui/realm';
 *
 * const tree = await renderRealm('./report.tsx', { props: { period: '2026-Q1' } });
 * ```
 */
export async function renderRealm(
  entry: string,
  options: RenderRealmOptions = {},
): Promise<PortableVNode> {
  const props = (options.props ?? {}) as Record<string, PortableValue>;
  const trees = await runRenderRealm(entry, props, [{}], options);
  return trees[0]!;
}

/**
 * Render one component across many prop sets in a single realm.
 *
 * Each item is rendered as `Component({ ...shared, ...item })` and the trees are
 * returned in item order. One isolate is created and `shared` crosses the
 * boundary once, so a build that renders hundreds of pages from one component
 * pays the setup and serialization cost a single time.
 *
 * Completion works exactly as it does for a single render: every revision
 * republishes the whole batch, and the last batch before the child exits is the
 * result.
 *
 * ```ts no_run
 * import { renderRealmAll } from 'fino:ui/realm';
 *
 * const trees = await renderRealmAll('./theme.tsx', {
 *   shared: { site },
 *   items: pages.map((page) => ({ page })),
 * });
 * ```
 */
export function renderRealmAll(
  entry: string,
  options: RenderRealmAllOptions,
): Promise<PortableVNode[]> {
  if (options.items.length === 0) return Promise.resolve([]);
  return runRenderRealm(entry, options.shared ?? {}, options.items, options);
}
