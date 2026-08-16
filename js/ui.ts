/**
 * fino:ui — host-neutral component construction and rendering.
 *
 * `fino:ui` is the portable core for JSX-style Fino interfaces. It owns VNode
 * construction, function components, keyed reconciliation, and the render
 * programs that drive them. It re-exports the reactive primitives from
 * `fino:signals` for compatibility, but the signal kernel itself is shared
 * runtime infrastructure. This module does not know about the DOM, HTML,
 * terminal cells, input devices, or styling rules. Renderers such as
 * `fino:tty/tui` and `fino:ui/html` provide those host details.
 *
 * ## Design
 *
 * Components are plain synchronous functions from props to a tree. They hold no
 * hidden state and perform no asynchronous work: state lives in explicit
 * `Signal` objects the component reads, so the same component renders the same
 * way wherever it runs.
 *
 * What varies is the *render program* around it, along two independent axes.
 * A `Sink` decides what a committed tree becomes — HTML text, a terminal frame,
 * a portable JSON descriptor, or mutations against a `HostAdapter`. The choice
 * of `renderStatic()` or `createRoot()` decides the lifetime: one pass and done,
 * or re-render for as long as the tree's signals keep changing.
 *
 * Asynchronous state is therefore never a component concern. It reaches a tree
 * by resolving into a signal, which re-renders whatever root is watching.
 * `fino:ui/realm` builds the third option on that: a component rendered in a
 * child realm publishes a tree per revision and completes when the realm's
 * event loop drains, which turns async data loading into static output without
 * either side changing.
 *
 * ```ts no_run
 * /** @jsxImportSource fino:ui *\/
 * import { createRoot, createSignal, renderStatic } from 'fino:ui';
 * import { htmlSink } from 'fino:ui/html';
 *
 * const count = createSignal(0);
 *
 * function Counter() {
 *   return <label>Count: {count.get()}</label>;
 * }
 *
 * const once = renderStatic(Counter, htmlSink());
 * const live = createRoot(Counter, htmlSink());
 * count.set(1);
 * live.dispose();
 * ```
 */
import { Signal, batch, createSignal, effect, withWriteGuard } from 'fino:signals';
export { Signal, batch, createSignal };
export type { ObservedReads, ReadonlySignal, SignalSetter, SignalSubscriber } from 'fino:signals';

/**
 * Primitive child value accepted by `h()`.
 *
 * Numbers are stringified, nested arrays are flattened, and `null`,
 * `undefined`, and boolean placeholders are ignored during normalization.
 */
export type Child = VNode | string | number | boolean | null | undefined | Child[];
/**
 * Function component accepted by `h()`.
 *
 * Components receive normalized props plus an optional normalized `children`
 * array. They return a concrete VNode; components do not keep hidden hook state.
 */
export type Component<P = Record<string, unknown>> = (
  props: P & {
    children?: NormalizedChild[];
  },
) => VNode;
/**
 * Host-neutral element or component type accepted by `h()`.
 *
 * Strings are host element names, `Fragment` groups children without a host
 * node, and functions are components — stored on the node and invoked later,
 * by whichever render target lowers the tree.
 */
export type VNodeType = string | typeof Fragment | Component<any>;
/**
 * Name of a render target, used as the second key into the lowering registry.
 *
 * Targets are open: `'tui'` and `'html'` ship here, but a name is just a
 * string, so a target defined outside this framework participates on equal
 * terms.
 */
export type RenderTargetName = string;
/**
 * Child value after normalization.
 *
 * A normalized child is either a VNode or text. Empty placeholders and nested
 * arrays have already been removed.
 */
export type NormalizedChild = VNode | string;
/**
 * Props object stored on a VNode after `key` and `children` are removed.
 */
export type Props = Record<string, unknown>;
/**
 * Host-neutral virtual node produced by `h()` and the JSX runtime.
 *
 * `type` is either a host element name or a renderer-specific component output
 * type. `props` never includes `key` or `children`; `children` is already
 * flattened and does not contain `null`, `undefined`, or boolean placeholders.
 */
export interface VNode {
  /**
   * Host element name, `'fragment'` for fragment VNodes, or the component
   * function itself — components are stored, not invoked, so a render target
   * can substitute its own lowering for them.
   */
  type: string | Component<any>;
  /**
   * Host props with `key` and `children` removed.
   */
  props: Props;
  /**
   * Flattened child nodes and text.
   */
  children: NormalizedChild[];
  /**
   * Optional reconciliation key copied from the original props.
   */
  key: string | number | null;
}
/**
 * Fragment marker used by JSX to group children without adding a host node.
 *
 * `h(Fragment, null, ...)` returns the normalized children to its parent rather
 * than creating a renderer-visible node.
 */
export const Fragment = Symbol('fino.ui.Fragment');
function normalizeChild(input: Child, out: NormalizedChild[]): void {
  if (input === null || input === undefined || typeof input === 'boolean') return;
  if (Array.isArray(input)) {
    for (const child of input) normalizeChild(child, out);
    return;
  }
  if (typeof input === 'number') {
    out.push(String(input));
    return;
  }
  if (typeof input !== 'string' && typeof input.type === 'string' && input.type === 'fragment') {
    for (const child of input.children) normalizeChild(child, out);
    return;
  }
  out.push(input);
}
function normalizeChildren(children: Child[]): NormalizedChild[] {
  const out: NormalizedChild[] = [];
  for (const child of children) normalizeChild(child, out);
  return out;
}
/**
 * Construct a host-neutral VNode.
 *
 * `key` is copied out of props and stored on the VNode for reconciliation.
 * `children` from props and variadic children are merged, flattened, and
 * stripped of empty placeholders.
 *
 * Function components are **not** invoked here. The function is stored as the
 * node's `type` and runs later, during `lowerTree()`, so that a render target
 * gets the chance to substitute its own lowering for that component first —
 * see `mapRenderTargetLowering()`. Calling a component directly still works
 * and simply bypasses the registry.
 *
 * ```ts no_run
 * import { h } from 'fino:ui';
 *
 * const button = h('button', { key: 'save', disabled: true }, 'Save');
 * ```
 */
export function h(type: VNodeType, props: Props | null, ...children: Child[]): VNode {
  const rawProps = props ?? {};
  const allChildren =
    children.length > 0
      ? children
      : Object.prototype.hasOwnProperty.call(rawProps, 'children')
        ? [rawProps.children as Child]
        : [];
  const normalizedChildren = normalizeChildren(allChildren);
  if (type === Fragment) {
    return {
      type: 'fragment',
      props: {},
      children: normalizedChildren,
      key: null,
    };
  }
  const keyValue = rawProps.key;
  const normalizedProps: Props = {};
  for (const name of Object.keys(rawProps)) {
    if (name !== 'key' && name !== 'children') normalizedProps[name] = rawProps[name];
  }
  return {
    type,
    props: normalizedProps,
    children: normalizedChildren,
    key: typeof keyValue === 'string' || typeof keyValue === 'number' ? keyValue : null,
  };
}

// ---------------------------------------------------------------------------
// Render targets and the lowering registry
// ---------------------------------------------------------------------------

interface RenderTargetSpec {
  /** Node names this target can consume directly, or `null` to accept any. */
  primitives: Set<string> | null;
}

const renderTargets = new Map<RenderTargetName, RenderTargetSpec>();
const componentLowerings = new WeakMap<Component<any>, Map<RenderTargetName, Component<any>>>();
const elementLowerings = new Map<string, Map<RenderTargetName, Component<any>>>();
const componentNames = new WeakMap<Component<any>, string>();

/**
 * A tree reached a node the target has no lowering for.
 *
 * The message names both the node and the target, because the fix is always
 * one of two registrations: a lowering for that component, or a lowering for
 * the host element it produced.
 */
export class RenderTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RenderTargetError';
  }
}

/**
 * Declare a render target and the node names it consumes directly.
 *
 * `primitives` is the target's floor: the names it paints itself, below which
 * no further lowering happens. Omit it to accept any node name, which suits a
 * target whose vocabulary is open-ended — HTML tags, for instance.
 *
 * ```ts no_run
 * import { defineRenderTarget } from 'fino:ui';
 *
 * defineRenderTarget('canvas', { primitives: ['canvas:rect', 'canvas:text'] });
 * ```
 */
export function defineRenderTarget(
  name: RenderTargetName,
  options: { primitives?: Iterable<string> } = {},
): void {
  renderTargets.set(name, {
    primitives: options.primitives === undefined ? null : new Set(options.primitives),
  });
}

/**
 * Map a component or host element name to a target-specific lowering.
 *
 * This is the open half of the render model. A component's own function is its
 * default behaviour; registering a lowering for a target replaces that
 * behaviour when the tree is lowered for that target, and leaves every other
 * target alone. Registration is deliberately not the component author's
 * privilege — a render target can lower components it did not write and cannot
 * modify, which is what lets a target be added without editing the catalog.
 *
 * A string key matches a host element name, so a target can catch elements
 * generically (`'article'`, `'strong'`) rather than specialising every
 * component that emits them. The last registration for a pair wins.
 *
 * ```ts no_run
 * import { mapRenderTargetLowering } from 'fino:ui';
 *
 * mapRenderTargetLowering(Checkbox, 'tui', TuiCheckbox);
 * mapRenderTargetLowering('article', 'tui', TuiArticle);
 * ```
 */
export function mapRenderTargetLowering<P>(
  type: Component<P> | string,
  target: RenderTargetName,
  lowering: Component<P>,
): void {
  if (typeof type === 'string') {
    let byTarget = elementLowerings.get(type);
    if (byTarget === undefined) {
      byTarget = new Map();
      elementLowerings.set(type, byTarget);
    }
    byTarget.set(target, lowering as Component<any>);
    return;
  }
  let byTarget = componentLowerings.get(type as Component<any>);
  if (byTarget === undefined) {
    byTarget = new Map();
    componentLowerings.set(type as Component<any>, byTarget);
  }
  byTarget.set(target, lowering as Component<any>);
}

/** The lowering registered for `type` on `target`, if any. */
export function renderTargetLowering(
  type: string | Component<any>,
  target: RenderTargetName,
): Component<any> | undefined {
  return typeof type === 'string'
    ? elementLowerings.get(type)?.get(target)
    : componentLowerings.get(type)?.get(target);
}

/**
 * Give a component a stable name for boundaries that carry names, not code.
 *
 * A portable tree identifies a node by string, so a component crossing a realm
 * or an SSE stream needs a name its receiver can route. `fn.name` is the
 * default and is usually enough; register an explicit, namespaced name when a
 * component must survive a boundary and its bare function name could collide.
 */
export function nameComponent(component: Component<any>, name: string): void {
  componentNames.set(component, name);
}

/** The name a node's type is known by: the string itself, or the component's name. */
export function componentName(type: string | Component<any>): string {
  if (typeof type === 'string') return type;
  return componentNames.get(type) ?? type.name;
}

// A lowering chain that never reaches a primitive is a bug in a lowering, not
// a deep tree — this counts substitutions at one node, and resets per child.
const MAX_LOWERING_DEPTH = 100;

/**
 * Lower a tree until nothing is left but the target's own primitives.
 *
 * Each node resolves to the lowering registered for it on `target`, or to the
 * component function itself when none is registered, and the result is lowered
 * again — so a component may compose other components and the chain resolves
 * to a fixpoint. A node whose type is already one of the target's primitives
 * passes through with its children lowered.
 *
 * The node's `key` transplants onto whatever it lowered to, so reconciliation
 * sees the identity the source tree declared. Subtrees that did not change are
 * returned by reference, which is what lets a host reconciler skip them.
 */
export function lowerTree(node: VNode, target: RenderTargetName): VNode {
  return lowerNode(node, target, 0);
}

function lowerNode(node: VNode, target: RenderTargetName, depth: number): VNode {
  if (depth > MAX_LOWERING_DEPTH) {
    throw new RenderTargetError(
      `Lowering '${componentName(node.type)}' for target '${target}' did not reach a primitive ` +
        `after ${MAX_LOWERING_DEPTH} substitutions — a lowering is probably emitting its own type`,
    );
  }
  const lowering = renderTargetLowering(node.type, target);
  const impl = lowering ?? (typeof node.type === 'function' ? node.type : undefined);
  if (impl !== undefined) {
    const composed = impl({ ...node.props, children: node.children });
    return lowerNode(node.key === null ? composed : { ...composed, key: node.key }, target, depth + 1);
  }
  const spec = renderTargets.get(target);
  const type = node.type as string;
  if (spec?.primitives && !spec.primitives.has(type)) {
    throw new RenderTargetError(
      `No '${target}' lowering for '${type}'. Register one with ` +
        `mapRenderTargetLowering('${type}', '${target}', …), or lower the component that emits it.`,
    );
  }
  let changed = false;
  const children = node.children.map((child) => {
    if (typeof child === 'string') return child;
    const lowered = lowerNode(child, target, 0);
    if (lowered !== child) changed = true;
    return lowered;
  });
  return changed ? { ...node, children } : node;
}
/**
 * Host adapter consumed by `createRenderer()`.
 *
 * Hosts own the concrete node representation. The renderer calls `beginUpdate`
 * and `endUpdate` once around each `render()` call when those hooks are
 * provided.
 *
 * ## Contract
 *
 * `createNode()` and `createText()` allocate host nodes. `insertChild()`,
 * `moveChild()`, and `removeChild()` mutate child order under a parent or root.
 * `updateNode()` replaces host props for an existing element, and `setText()`
 * updates an existing text node.
 */
export interface HostAdapter<Node, Root> {
  /**
   * Create a host element node for `type` and `props`.
   */
  createNode(type: string, props: Props): Node;
  /**
   * Create a host text node.
   */
  createText(text: string): Node;
  /**
   * Replace or patch props on an existing host element node.
   */
  updateNode(node: Node, props: Props): void;
  /**
   * Update an existing host text node.
   */
  setText(node: Node, text: string): void;
  /**
   * Insert `child` under `parent` at `index`.
   */
  insertChild(parent: Node | Root, child: Node, index: number): void;
  /**
   * Move an existing `child` under `parent` to `index`.
   */
  moveChild(parent: Node | Root, child: Node, index: number): void;
  /**
   * Remove `child` from `parent`.
   */
  removeChild(parent: Node | Root, child: Node): void;
  /**
   * Optional hook called before each render pass.
   */
  beginUpdate?(): void;
  /**
   * Optional hook called after each render pass, including failed passes.
   */
  endUpdate?(): void;
}
interface Mounted<Node> {
  kind: 'node' | 'text';
  node: Node;
  type: string;
  key: string | number | null;
  props: Props;
  text: string | null;
  children: Mounted<Node>[];
}
function childKey(child: NormalizedChild, index: number): string | number {
  return typeof child === 'string' ? `#${index}` : (child.key ?? `#${index}`);
}
function mount<Node, Root>(
  host: HostAdapter<Node, Root>,
  vnode: NormalizedChild,
  parent: Node | Root,
  index: number,
): Mounted<Node> {
  if (typeof vnode === 'string') {
    const node = host.createText(vnode);
    host.insertChild(parent, node, index);
    return {
      kind: 'text',
      node,
      type: '#text',
      key: null,
      props: {},
      text: vnode,
      children: [],
    };
  }
  if (typeof vnode.type !== 'string') {
    // A host only ever sees primitives. Reaching one with a component still on
    // it means the tree was committed without being lowered for this target.
    throw new RenderTargetError(
      `Component '${componentName(vnode.type)}' reached the host unlowered — ` +
        `commit through a sink that calls lowerTree() for its target`,
    );
  }
  const node = host.createNode(vnode.type, vnode.props);
  const mounted: Mounted<Node> = {
    kind: 'node',
    node,
    type: vnode.type,
    key: vnode.key,
    props: vnode.props,
    text: null,
    children: [],
  };
  host.insertChild(parent, node, index);
  vnode.children.forEach((child, childIndex) => {
    mounted.children.push(mount(host, child, node, childIndex));
  });
  return mounted;
}
function unmount<Node, Root>(
  host: HostAdapter<Node, Root>,
  mounted: Mounted<Node>,
  parent: Node | Root,
): void {
  host.removeChild(parent, mounted.node);
}
function reconcile<Node, Root>(
  host: HostAdapter<Node, Root>,
  mounted: Mounted<Node>,
  vnode: NormalizedChild,
  parent: Node | Root,
  index: number,
): Mounted<Node> {
  if (typeof vnode === 'string') {
    if (mounted.kind !== 'text') {
      unmount(host, mounted, parent);
      return mount(host, vnode, parent, index);
    }
    if (mounted.text !== vnode) {
      host.setText(mounted.node, vnode);
      mounted.text = vnode;
    }
    host.moveChild(parent, mounted.node, index);
    return mounted;
  }
  if (mounted.kind !== 'node' || mounted.type !== vnode.type || mounted.key !== vnode.key) {
    unmount(host, mounted, parent);
    return mount(host, vnode, parent, index);
  }
  mounted.props = vnode.props;
  host.updateNode(mounted.node, vnode.props);
  reconcileChildren(host, mounted, vnode.children);
  host.moveChild(parent, mounted.node, index);
  return mounted;
}
function reconcileChildren<Node, Root>(
  host: HostAdapter<Node, Root>,
  mounted: Mounted<Node>,
  children: NormalizedChild[],
): void {
  const existing = new Map<string | number, Mounted<Node>>();
  mounted.children.forEach((child, index) => existing.set(child.key ?? `#${index}`, child));
  const nextMounted: Mounted<Node>[] = [];
  children.forEach((child, index) => {
    const key = childKey(child, index);
    const current = existing.get(key);
    if (current) {
      existing.delete(key);
      nextMounted.push(reconcile(host, current, child, mounted.node, index));
    } else {
      nextMounted.push(mount(host, child, mounted.node, index));
    }
  });
  for (const child of existing.values()) unmount(host, child, mounted.node);
  mounted.children = nextMounted;
}
/**
 * Create a renderer for a concrete host adapter.
 *
 * The renderer keeps one mounted tree per root object. Re-rendering the same
 * root reconciles by element type and child keys, producing host updates inside
 * one update batch.
 *
 * Children without explicit keys are matched by position. Text nodes are keyed
 * by their index, while VNodes prefer their `key` and fall back to index.
 *
 * ```ts no_run
 * import { createRenderer, h } from 'fino:ui';
 *
 * const renderer = createRenderer(host);
 * renderer.render(h('label', null, 'Ready'), root);
 * ```
 */
export function createRenderer<Node, Root>(host: HostAdapter<Node, Root>) {
  const roots = new WeakMap<object, Mounted<Node>>();
  return {
    render(element: VNode, root: Root): void {
      host.beginUpdate?.();
      try {
        const rootKey = root as object;
        const previous = roots.get(rootKey);
        if (previous) {
          roots.set(rootKey, reconcile(host, previous, element, root, 0));
        } else {
          roots.set(rootKey, mount(host, element, root, 0));
        }
      } finally {
        host.endUpdate?.();
      }
    },
  };
}
/**
 * Destination for a rendered tree.
 *
 * A sink is the whole of what a host contributes to a render program: it turns
 * one complete VNode tree into whatever that host cares about, and releases any
 * resources it holds when the render program ends. `commit()` is called once per
 * render pass and its return value becomes the root's output.
 *
 * Sinks come in two shapes. A *snapshot* sink is total and stateless — HTML
 * text, a terminal frame, a portable JSON descriptor. An *incremental* sink
 * keeps a mounted tree and mutates a host node graph; wrap a `HostAdapter` with
 * `hostSink()` to get one.
 */
export interface Sink<Out> {
  /** Turn one complete tree into this host's output. */
  commit(tree: VNode): Out;
  /** Release host resources when the render program ends. */
  dispose?(): void;
}
/**
 * Handle for a continuously rendered tree.
 *
 * The root re-renders whenever a signal read during the previous pass changes,
 * so `output` always reflects the latest committed tree.
 */
export interface Root<Out> {
  /** Output of the most recent commit. */
  readonly output: Out;
  /**
   * Observe every subsequent commit.
   *
   * The callback is not called for the render that already happened; read
   * `output` for that. The returned function removes the subscription.
   */
  subscribe(subscriber: (output: Out) => void): () => void;
  /** Stop re-rendering and dispose the sink. Safe to call more than once. */
  dispose(): void;
}
/**
 * Signal write attempted during a one-shot render.
 *
 * `renderStatic()` has no way to publish a second tree, so a component that
 * mutates state during its pass has produced output that does not match its
 * own state. Render in a realm, or with `createRoot()`, when state must change.
 */
export class StaticRenderError extends Error {
  constructor(message = 'Cannot set a signal during a static render') {
    super(message);
    this.name = 'StaticRenderError';
  }
}
/**
 * Render one tree, commit it, and dispose the sink.
 *
 * This is the one-shot half of the render model: exactly one pass, no
 * subscriptions, no way to publish a revision. Signal *reads* are ordinary, so
 * a component can render whatever state already holds; a signal *write* during
 * the pass throws `StaticRenderError`, because the committed output could never
 * reflect it.
 *
 * Only synchronous writes are caught. Components are synchronous by
 * construction, so state that arrives later belongs to a render program with
 * somewhere to publish it — `createRoot()`, or a realm rendered to completion.
 *
 * ```ts no_run
 * import { h, renderStatic } from 'fino:ui';
 * import { htmlSink } from 'fino:ui/html';
 *
 * const html = renderStatic(() => h('main', null, 'Ready'), htmlSink());
 * ```
 */
export function renderStatic<Out>(element: () => VNode, sink: Sink<Out>): Out {
  try {
    // The guard covers the commit too, not just `element()`: components are
    // stored by `h()` and run when the sink lowers the tree, so most of a
    // render pass now happens inside `commit`.
    return withWriteGuard(
      () => {
        throw new StaticRenderError();
      },
      () => sink.commit(element()),
    );
  } finally {
    sink.dispose?.();
  }
}
/**
 * Render continuously until disposed.
 *
 * The first pass runs immediately. Every signal read during a pass becomes a
 * dependency, so later writes re-render and commit again; dependencies are
 * re-tracked on each pass. Use `batch()` to coalesce a burst of writes into one
 * commit.
 *
 * ```ts no_run
 * import { createRoot, createSignal, h } from 'fino:ui';
 * import { htmlSink } from 'fino:ui/html';
 *
 * const name = createSignal('world');
 * const root = createRoot(() => h('p', null, `hello ${name.get()}`), htmlSink());
 * root.subscribe((html) => console.log(html));
 * name.set('fino');
 * root.dispose();
 * ```
 */
export function createRoot<Out>(element: () => VNode, sink: Sink<Out>): Root<Out> {
  const subscribers = new Set<(output: Out) => void>();
  let output!: Out;
  let disposed = false;
  // The first pass runs before this function returns, so no subscriber can
  // exist yet; that is what makes `subscribe()` observe later commits only.
  const stop = effect(() => {
    output = sink.commit(element());
    for (const subscriber of Array.from(subscribers)) subscriber(output);
  });
  return {
    get output(): Out {
      return output;
    },
    subscribe(subscriber: (output: Out) => void): () => void {
      subscribers.add(subscriber);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        subscribers.delete(subscriber);
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stop();
      subscribers.clear();
      sink.dispose?.();
    },
  };
}
/**
 * Adapt a `HostAdapter` and its root object into a `Sink`.
 *
 * The returned sink reconciles each committed tree against the previously
 * mounted one, so a host that owns mutable nodes participates in the same
 * render programs as a snapshot host.
 *
 * Pass `target` when the tree still contains components: the sink lowers for
 * that target before reconciling, so the host only ever sees its own
 * primitives. Omit it when the caller has already lowered.
 *
 * ```ts no_run
 * import { createRoot, hostSink } from 'fino:ui';
 *
 * const root = createRoot(App, hostSink(domHost, document.body, 'dom'));
 * ```
 */
export function hostSink<Node, RootNode>(
  host: HostAdapter<Node, RootNode>,
  root: RootNode,
  target?: RenderTargetName,
): Sink<void> {
  const renderer = createRenderer(host);
  return {
    commit(tree: VNode): void {
      renderer.render(target === undefined ? tree : lowerTree(tree, target), root);
    },
  };
}
