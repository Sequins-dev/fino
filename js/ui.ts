/**
 * fino:ui — host-neutral component construction, signals, and rendering.
 *
 * `fino:ui` is the portable core for JSX-style Fino interfaces. It owns VNode
 * construction, function components, explicit signal subscriptions, batching,
 * and keyed reconciliation into a host adapter. It does not know about the DOM,
 * HTML, terminal cells, input devices, or styling rules. Renderers such as
 * `fino:tty/tui` provide those host details.
 *
 * ## Design
 *
 * Components are plain functions that receive normalized props and a
 * `children` array. State is held in explicit `Signal` objects rather than
 * hook order. Hosts provide a small imperative adapter for creating nodes,
 * moving children, updating props, and batching mutations.
 *
 * ```ts no_run
 * /** @jsxImportSource fino:ui *\/
 * import { createSignal } from 'fino:ui';
 *
 * const count = createSignal(0);
 *
 * function Counter() {
 *   return <label>Count: {count.get()}</label>;
 * }
 *
 * count.subscribe(() => {
 *   // Ask the selected host renderer to render Counter again.
 * });
 * ```
 */

/** Primitive child value accepted by `h()`. */
export type Child = VNode | string | number | boolean | null | undefined | Child[];

/** Function component accepted by `h()`. */
export type Component<P = Record<string, unknown>> = (props: P & { children?: NormalizedChild[] }) => VNode;

/** Host-neutral component type. */
export type VNodeType = string | typeof Fragment | Component<any>;

/** Child value after normalization. */
export type NormalizedChild = VNode | string;

/** Props object stored on a VNode after `key` and `children` are removed. */
export type Props = Record<string, unknown>;

/**
 * Host-neutral virtual node produced by `h()` and the JSX runtime.
 *
 * `type` is either a host element name or a renderer-specific component output
 * type. `props` never includes `key` or `children`; `children` is already
 * flattened and does not contain `null`, `undefined`, or boolean placeholders.
 */
export interface VNode {
  type: string;
  props: Props;
  children: NormalizedChild[];
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
  if (typeof input !== 'string' && input.type === 'fragment') {
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
 * Construct a host-neutral VNode or invoke a function component.
 *
 * `key` is copied out of props and stored on the VNode for reconciliation.
 * `children` from props and variadic children are merged, flattened, and
 * stripped of empty placeholders. Function components receive the normalized
 * children as `props.children`.
 */
export function h(type: VNodeType, props: Props | null, ...children: Child[]): VNode {
  const rawProps = props ?? {};
  const allChildren = children.length > 0
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

  if (typeof type === 'function') {
    return type({ ...normalizedProps, children: normalizedChildren });
  }

  return {
    type,
    props: normalizedProps,
    children: normalizedChildren,
    key: typeof keyValue === 'string' || typeof keyValue === 'number' ? keyValue : null,
  };
}

type SignalSubscriber<T> = (value: T, previous: T) => void;
type SignalSetter<T> = T | ((value: T) => T);

let batchDepth = 0;
const pendingSignals = new Set<Signal<unknown>>();

function flushSignals(): void {
  const pending = Array.from(pendingSignals);
  pendingSignals.clear();
  for (const signal of pending) signal.flush();
}

/**
 * Run multiple signal writes as one notification pass.
 *
 * Subscribers are called after the outermost batch completes, and each changed
 * signal notifies at most once with its final value.
 */
export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0) flushSignals();
  }
}

/**
 * Explicit reactive value used by Fino UI components and renderers.
 *
 * Signals are intentionally independent from component rendering. Call
 * `subscribe()` to schedule a renderer update, use `get()` while building a
 * tree, and use `set()` to replace or derive the next value.
 */
export class Signal<T> {
  #value: T;
  #previous: T;
  #dirty = false;
  #subscribers = new Set<SignalSubscriber<T>>();

  constructor(initial: T) {
    this.#value = initial;
    this.#previous = initial;
  }

  /** Return the current signal value. */
  get(): T {
    return this.#value;
  }

  /**
   * Replace the value or derive the next value from the current one.
   *
   * Subscribers are skipped when `Object.is(previous, next)` is true.
   */
  set(next: SignalSetter<T>): void {
    const previous = this.#value;
    const value = typeof next === 'function' ? (next as (value: T) => T)(previous) : next;
    if (Object.is(previous, value)) return;
    if (!this.#dirty) this.#previous = previous;
    this.#value = value;
    this.#dirty = true;
    if (batchDepth > 0) {
      pendingSignals.add(this as Signal<unknown>);
    } else {
      this.flush();
    }
  }

  /**
   * Subscribe to value changes.
   *
   * The returned function removes the subscriber. Subscriptions do not fire
   * immediately; they only observe subsequent writes.
   */
  subscribe(subscriber: SignalSubscriber<T>): () => void {
    this.#subscribers.add(subscriber);
    return () => {
      this.#subscribers.delete(subscriber);
    };
  }

  /** @internal Flush one pending notification pass. */
  flush(): void {
    if (!this.#dirty) return;
    this.#dirty = false;
    const previous = this.#previous;
    const value = this.#value;
    for (const subscriber of Array.from(this.#subscribers)) subscriber(value, previous);
  }
}

/**
 * Create a signal with explicit `get`, `set`, and `subscribe` methods.
 */
export function createSignal<T>(initial: T): Signal<T> {
  return new Signal(initial);
}

/**
 * Host adapter consumed by `createRenderer()`.
 *
 * Hosts own the concrete node representation. The renderer calls `beginUpdate`
 * and `endUpdate` once around each `render()` call when those hooks are
 * provided.
 */
export interface HostAdapter<Node, Root> {
  createNode(type: string, props: Props): Node;
  createText(text: string): Node;
  updateNode(node: Node, props: Props): void;
  setText(node: Node, text: string): void;
  insertChild(parent: Node | Root, child: Node, index: number): void;
  moveChild(parent: Node | Root, child: Node, index: number): void;
  removeChild(parent: Node | Root, child: Node): void;
  beginUpdate?(): void;
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
  return typeof child === 'string' ? `#${index}` : child.key ?? `#${index}`;
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
    return { kind: 'text', node, type: '#text', key: null, props: {}, text: vnode, children: [] };
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

function unmount<Node, Root>(host: HostAdapter<Node, Root>, mounted: Mounted<Node>, parent: Node | Root): void {
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
