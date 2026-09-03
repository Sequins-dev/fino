/**
 * Retained terminal node tree: the `HostAdapter` behind live TUI rendering.
 *
 * `fino:ui`'s reconciler mounts and mutates this tree; layout runs over the
 * retained nodes so unchanged subtrees keep their measurement caches. Damage
 * rules: props are diffed before dirtying (the reconciler passes a fresh props
 * object every pass), a same-index move is a no-op, and removal releases the
 * whole subtree's caches — the reconciler's unmount is shallow by contract.
 *
 * @internal
 */
import type { HostAdapter, Props } from 'fino:ui';
import { invalidateMeasure } from 'internal:tty/layout';
import type { LayoutNode } from 'internal:tty/layout';

export interface TerminalNode extends LayoutNode {
  readonly type: string;
  props: Props;
  parent: TerminalNode | TerminalRoot | null;
  children: TerminalNode[];
  text: string | null;
}

export interface TerminalRoot {
  children: TerminalNode[];
  /** Bumped whenever anything in the tree changes, for cheap dirty checks. */
  revision: number;
  onRelease?: (node: TerminalNode) => void;
}

export function createTerminalRoot(): TerminalRoot {
  return { children: [], revision: 0 };
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
    return true;
  }
  return false;
}

function propsEqual(a: Props, b: Props): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!shallowEqual(a[key], b[key])) return false;
  }
  return true;
}

function rootOf(node: TerminalNode): TerminalRoot | null {
  let current: TerminalNode | TerminalRoot | null = node;
  while (current && 'parent' in current) current = current.parent;
  return current;
}

function invalidateUp(start: TerminalNode | TerminalRoot | null): void {
  let current = start;
  while (current && 'parent' in current) {
    invalidateMeasure(current);
    current = current.parent;
  }
  if (current) current.revision++;
}

function releaseSubtree(node: TerminalNode, root: TerminalRoot | null): void {
  invalidateMeasure(node);
  root?.onRelease?.(node);
  for (const child of node.children) releaseSubtree(child, root);
  node.parent = null;
}

export function terminalHost(): HostAdapter<TerminalNode, TerminalRoot> {
  return {
    createNode(type: string, props: Props): TerminalNode {
      return { type, props, parent: null, children: [], text: null };
    },
    createText(text: string): TerminalNode {
      return { type: '#text', props: {}, parent: null, children: [], text };
    },
    updateNode(node: TerminalNode, props: Props): void {
      if (propsEqual(node.props, props)) {
        node.props = props;
        return;
      }
      node.props = props;
      invalidateUp(node);
    },
    setText(node: TerminalNode, text: string): void {
      if (node.text === text) return;
      node.text = text;
      invalidateUp(node);
    },
    insertChild(parent: TerminalNode | TerminalRoot, child: TerminalNode, index: number): void {
      child.parent = parent;
      parent.children.splice(Math.min(index, parent.children.length), 0, child);
      invalidateUp('parent' in parent ? parent : null);
      if (!('parent' in parent)) parent.revision++;
    },
    moveChild(parent: TerminalNode | TerminalRoot, child: TerminalNode, index: number): void {
      const current = parent.children.indexOf(child);
      if (current === index || current === -1) return;
      parent.children.splice(current, 1);
      parent.children.splice(Math.min(index, parent.children.length), 0, child);
      invalidateUp('parent' in parent ? parent : null);
      if (!('parent' in parent)) parent.revision++;
    },
    removeChild(parent: TerminalNode | TerminalRoot, child: TerminalNode): void {
      const current = parent.children.indexOf(child);
      if (current !== -1) parent.children.splice(current, 1);
      const root = 'parent' in parent ? rootOf(parent) : parent;
      releaseSubtree(child, root);
      invalidateUp('parent' in parent ? parent : null);
      if (!('parent' in parent)) parent.revision++;
    },
  };
}
