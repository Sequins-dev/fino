/**
 * fino:ui/portable — host-neutral trees as transferable data.
 *
 * A `fino:ui` tree is already plain-ish data, but nothing stops a component
 * from putting a class instance, a closure, or a cycle in its props. This
 * module defines the subset that survives leaving the isolate that built it,
 * and rejects everything else at the boundary rather than at the far end.
 *
 * That subset is what makes a component's location a deployment choice. The
 * same tree crosses a realm port via structured clone, an SSE stream as JSON,
 * or a `postMessage` to a browser, and the receiver routes `type` to whatever
 * implementation it has for that name. Nothing in a portable tree names a
 * server object, so nothing about where it was rendered leaks into it.
 *
 * ```ts no_run
 * import { h, renderStatic } from 'fino:ui';
 * import { portableSink } from 'fino:ui/portable';
 *
 * const tree = renderStatic(() => h('main', { id: 'root' }, 'Ready'), portableSink());
 * ```
 */
import { componentName } from 'fino:ui';
import type { Sink, VNode } from 'fino:ui';

/**
 * JSON value allowed to cross a UI boundary.
 *
 * Functions, class instances, non-finite numbers, and cyclic values are
 * rejected before a tree is published.
 */
export type PortableValue =
  | null
  | boolean
  | number
  | string
  | PortableValue[]
  | { [key: string]: PortableValue };

/**
 * Host-neutral component node in transferable form.
 *
 * Receivers route `type` to their own named implementation. `key` is semantic
 * instance identity for reconciliation; it is not a component implementation
 * id.
 */
export interface PortableVNode {
  /** Named component implementation requested from the receiver. */
  type: string;
  /** JSON props interpreted by that implementation. */
  props: Record<string, PortableValue>;
  /** Ordered child components and text. */
  children: Array<PortableVNode | string>;
  /** Stable instance identity, or `null` when the node is unkeyed. */
  key: string | number | null;
}

/**
 * Value rejected while converting a tree to portable form.
 *
 * The message names the property path so a component author can find the prop
 * that cannot cross, rather than learning only that "something" failed.
 */
export class PortableValueError extends TypeError {
  /** Dotted path from the tree root to the offending value. */
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${message} at ${path}`);
    this.name = 'PortableValueError';
    this.path = path;
  }
}

function convert(value: unknown, path: string, seen: Set<object>): PortableValue {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  if (typeof value !== 'object')
    throw new PortableValueError(path, `Portable UI values must be JSON data, got ${typeof value}`);
  if (seen.has(value)) throw new PortableValueError(path, 'Portable UI values must not be cyclic');
  seen.add(value);
  try {
    if (Array.isArray(value))
      return value.map((entry, index) =>
        entry === undefined ? null : convert(entry, `${path}[${index}]`, seen),
      );
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
      throw new PortableValueError(path, 'Portable UI values must be plain objects');
    const out: Record<string, PortableValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === undefined) continue;
      out[key] = convert(entry, `${path}.${key}`, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Convert a rendered tree to its transferable form.
 *
 * The result is structured-clone safe and `JSON.stringify` safe, and matches
 * what a JSON round-trip would produce: an `undefined` prop is omitted, since a
 * prop set to `undefined` and one never set are the same absent prop, and an
 * `undefined` array element becomes `null` so positions are preserved.
 *
 * A value that cannot cross at all — a function, a class instance, a cycle —
 * throws `PortableValueError` naming its path rather than being dropped, because
 * a receiver cannot tell a dropped prop from one that was never sent.
 *
 * ```ts no_run
 * import { h } from 'fino:ui';
 * import { toPortable } from 'fino:ui/portable';
 *
 * const tree = toPortable(h('button', { disabled: true }, 'Save'));
 * ```
 */
export function toPortable(tree: VNode): PortableVNode {
  return convert(named(tree, 'tree'), 'tree', new Set<object>()) as unknown as PortableVNode;
}

/**
 * Replace component types with the names their receiver routes by.
 *
 * `h()` stores a component function rather than invoking it, but a portable
 * tree carries names, not code — a receiver resolves `type` against its own
 * implementations. An anonymous component has nothing to resolve, so it is
 * rejected here rather than arriving as an empty string.
 */
function named(node: VNode, path: string): VNode {
  const name = componentName(node.type);
  if (name === '') {
    throw new PortableValueError(
      `${path}.type`,
      'Portable UI components must have a name; give it one with nameComponent()',
    );
  }
  let changed = name !== node.type;
  const children = node.children.map((child, index) => {
    if (typeof child === 'string') return child;
    const next = named(child, `${path}.children[${index}]`);
    if (next !== child) changed = true;
    return next;
  });
  return changed ? { ...node, type: name, children } : node;
}

/**
 * Sink that converts each committed tree to its transferable form.
 *
 * Use it wherever a rendered tree leaves the isolate that produced it: a realm
 * publishing revisions to its parent, a server streaming semantic updates, or a
 * build step recording a tree for a later host to interpret.
 *
 * ```ts no_run
 * import { createRoot } from 'fino:ui';
 * import { portableSink } from 'fino:ui/portable';
 *
 * const root = createRoot(App, portableSink());
 * root.subscribe((tree) => port.postMessage(tree));
 * ```
 */
export function portableSink(): Sink<PortableVNode> {
  return {
    commit(tree: VNode): PortableVNode {
      return toPortable(tree);
    },
  };
}
