/**
* fino:ui — host-neutral component construction and rendering.
*
* `fino:ui` is the portable core for JSX-style Fino interfaces. It owns VNode
* construction, function components, and keyed reconciliation into a host
* adapter. It re-exports the reactive primitives from `fino:signals` for
* compatibility, but the signal kernel itself is shared runtime
* infrastructure. This module does not know about the DOM, HTML, terminal
* cells, input devices, or styling rules. Renderers such as `fino:tty/tui`
* provide those host details.
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
import { Signal, batch, createSignal } from 'fino:signals';
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
export type Component<P = Record<string, unknown>> = (props: P & {
  children?: NormalizedChild[];
}) => VNode;
/**
* Host-neutral element or component type accepted by `h()`.
*
* Strings are host element names, `Fragment` groups children without a host
* node, and functions are invoked as components.
*/
export type VNodeType = string | typeof Fragment | Component<any>;
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
  * Host element name, or `'fragment'` for fragment VNodes.
  */
  type: string;
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
*
* ```ts no_run
* import { h } from 'fino:ui';
*
* const button = h('button', { key: 'save', disabled: true }, 'Save');
* ```
*/
export function h(type: VNodeType, props: Props | null, ...children: Child[]): VNode {
  const rawProps = props ?? {};
  const allChildren = children.length > 0 ? children : Object.prototype.hasOwnProperty.call(rawProps, 'children') ? [rawProps.children as Child] : [];
  const normalizedChildren = normalizeChildren(allChildren);
  if (type === Fragment) {
    return {
      type: 'fragment',
      props: {},
      children: normalizedChildren,
      key: null
    };
  }
  const keyValue = rawProps.key;
  const normalizedProps: Props = {};
  for (const name of Object.keys(rawProps)) {
    if (name !== 'key' && name !== 'children') normalizedProps[name] = rawProps[name];
  }
  if (typeof type === 'function') {
    return type({
      ...normalizedProps,
      children: normalizedChildren
    });
  }
  return {
    type,
    props: normalizedProps,
    children: normalizedChildren,
    key: typeof keyValue === 'string' || typeof keyValue === 'number' ? keyValue : null
  };
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
export interface HostAdapter<
  Node,
  Root
> {
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
  return typeof child === 'string' ? `#${index}` : child.key ?? `#${index}`;
}
function mount<
  Node,
  Root
>(host: HostAdapter<Node, Root>, vnode: NormalizedChild, parent: Node | Root, index: number): Mounted<Node> {
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
      children: []
    };
  }
  const node = host.createNode(vnode.type, vnode.props);
  const mounted: Mounted<Node> = {
    kind: 'node',
    node,
    type: vnode.type,
    key: vnode.key,
    props: vnode.props,
    text: null,
    children: []
  };
  host.insertChild(parent, node, index);
  vnode.children.forEach((child, childIndex) => {
    mounted.children.push(mount(host, child, node, childIndex));
  });
  return mounted;
}
function unmount<
  Node,
  Root
>(host: HostAdapter<Node, Root>, mounted: Mounted<Node>, parent: Node | Root): void {
  host.removeChild(parent, mounted.node);
}
function reconcile<
  Node,
  Root
>(host: HostAdapter<Node, Root>, mounted: Mounted<Node>, vnode: NormalizedChild, parent: Node | Root, index: number): Mounted<Node> {
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
function reconcileChildren<
  Node,
  Root
>(host: HostAdapter<Node, Root>, mounted: Mounted<Node>, children: NormalizedChild[]): void {
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
export function createRenderer<
  Node,
  Root
>(host: HostAdapter<Node, Root>) {
  const roots = new WeakMap<object, Mounted<Node>>();
  return { render(element: VNode, root: Root): void {
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
  } };
}
