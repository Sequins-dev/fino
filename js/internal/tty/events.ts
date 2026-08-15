/**
 * Focus and event routing over the retained terminal node tree.
 *
 * Mouse events hit-test to the deepest painted node containing the cell and
 * bubble up the ancestor chain; key events start at the focused node and
 * bubble. A handler returning `true` stops propagation. Focus is held by
 * node identity — it survives reconciliation because the reconciler reuses
 * retained nodes — and is exposed to components through a signal carrying
 * the focused node's `id`, since components can only observe state through
 * signals and props.
 *
 * @internal
 */
import { createSignal } from 'fino:signals';
import type { Signal } from 'fino:signals';
import { nodeRect } from 'internal:tty/layout';
import type { TerminalNode, TerminalRoot } from 'internal:tty/host';

export interface TuiKeyEventLike {
  type: 'key';
  key: string;
  text?: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
}

export interface TuiMouseEventLike {
  type: 'mouse';
  action: 'press' | 'release' | 'drag' | 'move' | 'wheel';
  button: string;
  x: number;
  y: number;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  /**
   * `x`/`y` relative to the deepest hit node's own painted rect — the
   * component-level equivalent of a DOM event's `offsetX`/`offsetY`. Set by
   * `#dispatchMouse` from the same `nodeRect` lookup hit-testing already
   * uses; absent when nothing was hit (e.g. a click outside all content).
   */
  localX?: number;
  localY?: number;
}

type Handler<E> = (event: E) => boolean | void;

function isFocusable(node: TerminalNode): boolean {
  if (node.props.disabled === true) return false;
  if (node.props.focusable === true) return true;
  return node.type === 'clickable' && node.props.focusable !== false;
}

function contains(node: TerminalNode, x: number, y: number): boolean {
  const rect = nodeRect(node);
  if (!rect) return false;
  return x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
}

function walk(node: TerminalNode, visit: (node: TerminalNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/** Routes input over a retained tree and tracks focus by node identity. */
export class TuiDispatcher {
  #root: TerminalRoot;
  #focused: TerminalNode | null = null;
  #pressed: TerminalNode | null = null;
  /** `id` of the focused node (or null); components subscribe to render focus. */
  readonly focusedId: Signal<string | null>;

  constructor(root: TerminalRoot) {
    this.#root = root;
    this.focusedId = createSignal<string | null>(null);
    root.onRelease = (node) => {
      if (this.#focused === node) this.#setFocus(null);
      if (this.#pressed === node) this.#pressed = null;
    };
  }

  get focused(): TerminalNode | null {
    return this.#focused;
  }

  #setFocus(node: TerminalNode | null): void {
    if (this.#focused === node) return;
    const previous = this.#focused;
    this.#focused = node;
    (previous?.props.onBlur as (() => void) | undefined)?.();
    (node?.props.onFocus as (() => void) | undefined)?.();
    this.focusedId.set(typeof node?.props.id === 'string' ? (node.props.id as string) : null);
  }

  #focusables(): TerminalNode[] {
    const out: TerminalNode[] = [];
    for (const top of this.#root.children) {
      walk(top, (node) => {
        if (isFocusable(node)) out.push(node);
      });
    }
    return out;
  }

  focusNext(delta = 1): boolean {
    const order = this.#focusables();
    if (order.length === 0) return false;
    const current = this.#focused ? order.indexOf(this.#focused) : -1;
    const next =
      current === -1
        ? delta > 0
          ? 0
          : order.length - 1
        : (current + delta + order.length) % order.length;
    this.#setFocus(order[next]!);
    return true;
  }

  focusPrev(): boolean {
    return this.focusNext(-1);
  }

  /** Focus the focusable node with the given `id`. */
  focusId(id: string): boolean {
    for (const node of this.#focusables()) {
      if (node.props.id === id) {
        this.#setFocus(node);
        return true;
      }
    }
    return false;
  }

  blur(): void {
    this.#setFocus(null);
  }

  /** Deepest painted node containing a cell, following the ancestor chain. */
  hitNode(x: number, y: number): TerminalNode | null {
    let best: TerminalNode | null = null;
    for (const top of this.#root.children) {
      walk(top, (node) => {
        if (contains(node, x, y)) best = node;
      });
    }
    return best;
  }

  #bubble<E>(start: TerminalNode | null, prop: string, event: E): boolean {
    let current: TerminalNode | null = start;
    while (current) {
      const handler = current.props[prop] as Handler<E> | undefined;
      if (typeof handler === 'function' && current.props.disabled !== true) {
        if (handler(event) === true) return true;
      }
      current = current.parent && 'parent' in current.parent ? current.parent : null;
    }
    return false;
  }

  #activate(node: TerminalNode | null): boolean {
    let current: TerminalNode | null = node;
    while (current) {
      const onClick = current.props.onClick as (() => void) | undefined;
      if (typeof onClick === 'function' && current.props.disabled !== true) {
        onClick();
        return true;
      }
      current = current.parent && 'parent' in current.parent ? current.parent : null;
    }
    return false;
  }

  /** Route one input event. Returns true when a handler consumed it. */
  dispatch(event: TuiKeyEventLike | TuiMouseEventLike): boolean {
    if (event.type === 'mouse') return this.#dispatchMouse(event);
    return this.#dispatchKey(event);
  }

  #dispatchMouse(event: TuiMouseEventLike): boolean {
    const target = this.hitNode(event.x, event.y);
    if (event.action === 'press') {
      this.#pressed = target;
      let focusable: TerminalNode | null = target;
      while (focusable && !isFocusable(focusable)) {
        focusable = focusable.parent && 'parent' in focusable.parent ? focusable.parent : null;
      }
      if (focusable) this.#setFocus(focusable);
    }
    const rect = target ? nodeRect(target) : undefined;
    const local = rect ? { localX: event.x - rect.x, localY: event.y - rect.y } : {};
    const handled = this.#bubble(target, 'onMouse', { ...event, ...local });
    if (handled) {
      if (event.action === 'release') this.#pressed = null;
      return true;
    }
    if (event.action === 'release') {
      const pressed = this.#pressed;
      this.#pressed = null;
      if (pressed && target && (pressed === target || isAncestor(pressed, target))) {
        return this.#activate(pressed);
      }
    }
    return false;
  }

  // With nothing focused, keys reach only nodes that opted in with
  // `captureKeys` — overlay surfaces catching Escape. Without the opt-in an
  // unfocused component would swallow keys the app needs elsewhere.
  #keyFallback(): TerminalNode | null {
    let last: TerminalNode | null = null;
    for (const top of this.#root.children) {
      walk(top, (node) => {
        if (node.props.captureKeys === true && typeof node.props.onKey === 'function') last = node;
      });
    }
    return last;
  }

  #dispatchKey(event: TuiKeyEventLike): boolean {
    if (this.#bubble(this.#focused ?? this.#keyFallback(), 'onKey', event)) return true;
    if (
      this.#focused &&
      (event.key === 'enter' || (event.key === ' ' && event.text === ' ')) &&
      !event.ctrl &&
      !event.alt
    ) {
      if (this.#activate(this.#focused)) return true;
    }
    if (event.key === 'tab' && !event.ctrl && !event.alt) {
      return this.focusNext(event.shift ? -1 : 1);
    }
    return false;
  }
}

function isAncestor(candidate: TerminalNode, node: TerminalNode): boolean {
  let current: TerminalNode | null = node.parent && 'parent' in node.parent ? node.parent : null;
  while (current) {
    if (current === candidate) return true;
    current = current.parent && 'parent' in current.parent ? current.parent : null;
  }
  return false;
}
