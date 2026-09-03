import { createRenderer } from 'fino:ui';
import type { VNode } from 'fino:ui';
import { frameToAnsi } from 'fino:tty/frame';
import { createTerminalRoot, terminalHost } from 'internal:tty/host';
import { TuiDispatcher } from 'internal:tty/events';
import type { TuiKeyEventLike, TuiMouseEventLike } from 'internal:tty/events';
import { layout } from 'internal:tty/layout';
import { lowerTui } from 'internal:tty/lower';

/** Reusable retained-terminal harness for component-family tests. */
export interface TuiHarness {
  readonly dispatcher: TuiDispatcher;
  render(tree: VNode): void;
  lines(): string[];
  ansi(): string;
  click(x: number, y: number): void;
  key(event: Omit<TuiKeyEventLike, 'type'>): boolean;
}

/** Remove SGR escapes and right padding from a rendered line. */
export function plainLine(line: string): string {
  return line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
}

/** Create one retained renderer, dispatcher, and layout surface. */
export function createTuiHarness(width = 30, height = 10): TuiHarness {
  const root = createTerminalRoot();
  const renderer = createRenderer(terminalHost());
  const dispatcher = new TuiDispatcher(root);
  let frame = layout({ type: 'fragment', props: {}, children: [], key: null }, { width, height });

  const mouse = (action: 'press' | 'release', x: number, y: number): TuiMouseEventLike => ({
    type: 'mouse',
    action,
    button: 'left',
    x,
    y,
    ctrl: false,
    alt: false,
    shift: false,
  });

  return {
    dispatcher,
    render(tree: VNode): void {
      renderer.render(lowerTui(tree), root);
      dispatcher.reconcile();
      const node = root.children[0];
      frame =
        node === undefined
          ? layout({ type: 'fragment', props: {}, children: [], key: null }, { width, height })
          : layout(node, { width, height });
    },
    lines(): string[] {
      return frame.rows.map((row) => row.segments.map((segment) => segment.text).join(''));
    },
    ansi(): string {
      return frameToAnsi(frame);
    },
    click(x: number, y: number): void {
      dispatcher.dispatch(mouse('press', x, y));
      dispatcher.dispatch(mouse('release', x, y));
    },
    key(event: Omit<TuiKeyEventLike, 'type'>): boolean {
      return dispatcher.dispatch({ type: 'key', ...event });
    },
  };
}
