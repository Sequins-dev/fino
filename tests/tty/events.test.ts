import { describe, it } from 'fino:test/test';
import { h, createRenderer, lowerTree } from 'fino:ui';
import type { VNode } from 'fino:ui';
import { Box, Clickable, Layer, Text } from 'fino:tty/tui';
import { createTerminalRoot, terminalHost } from 'internal:tty/host';
import type { TerminalRoot } from 'internal:tty/host';
import { layout } from 'internal:tty/layout';
import { TuiDispatcher } from 'internal:tty/events';
import type { TuiKeyEventLike, TuiMouseEventLike } from 'internal:tty/events';

interface Harness {
  root: TerminalRoot;
  dispatcher: TuiDispatcher;
  render(tree: VNode): void;
}

function harness(width = 20, height = 6): Harness {
  const root = createTerminalRoot();
  const renderer = createRenderer(terminalHost());
  const dispatcher = new TuiDispatcher(root);
  return {
    root,
    dispatcher,
    render(tree: VNode): void {
      renderer.render(lowerTree(tree, 'tui'), root);
      dispatcher.reconcile();
      layout(root.children[0]!, { width, height });
    },
  };
}

function press(x: number, y: number): TuiMouseEventLike {
  return {
    type: 'mouse',
    action: 'press',
    button: 'left',
    x,
    y,
    ctrl: false,
    alt: false,
    shift: false,
  };
}

function release(x: number, y: number): TuiMouseEventLike {
  return {
    type: 'mouse',
    action: 'release',
    button: 'left',
    x,
    y,
    ctrl: false,
    alt: false,
    shift: false,
  };
}

function key(name: string, extra: Partial<TuiKeyEventLike> = {}): TuiKeyEventLike {
  return { type: 'key', key: name, ...extra };
}

describe('internal:tty/events', () => {
  it('clicking anywhere inside a Clickable fires onClick', (t) => {
    const clicks: string[] = [];
    const { dispatcher, render } = harness();
    render(
      h(
        Box,
        { direction: 'column' },
        h(
          Clickable,
          { onClick: () => clicks.push('card'), direction: 'column' },
          h(Text, null, 'title line'),
          h(Text, null, 'body line'),
        ),
        h(Text, null, 'outside'),
      ),
    );
    dispatcher.dispatch(press(4, 0));
    t.equal(dispatcher.dispatch(release(4, 1)), true, 'release inside consumes');
    t.deepEqual(clicks, ['card'], 'different descendants still agree on the same clickable');
    dispatcher.dispatch(press(2, 2));
    t.equal(dispatcher.dispatch(release(2, 2)), false, 'outside the clickable nothing fires');
    t.deepEqual(clicks, ['card'], 'no extra click');
  });

  it('does not fire when the press and release land on different targets', (t) => {
    const clicks: string[] = [];
    const { dispatcher, render } = harness();
    render(
      h(
        Box,
        { direction: 'column' },
        h(Clickable, { onClick: () => clicks.push('a') }, h(Text, null, 'aaa')),
        h(Clickable, { onClick: () => clicks.push('b') }, h(Text, null, 'bbb')),
      ),
    );
    dispatcher.dispatch(press(1, 0));
    dispatcher.dispatch(release(1, 1));
    t.deepEqual(clicks, [], 'a drag off the target is not a click');
  });

  it('routes overlapping mouse hits to the node painted on top', (t) => {
    const clicks: string[] = [];
    const { dispatcher, render } = harness(20, 6);
    render(
      h(
        Box,
        null,
        h(
          Layer,
          { width: 8, height: 1 },
          h(Clickable, { onClick: () => clicks.push('layer') }, h(Text, null, 'overlay')),
        ),
        h(
          Clickable,
          { width: 20, height: 6, onClick: () => clicks.push('under') },
          h(Text, null, 'under'),
        ),
      ),
    );
    dispatcher.dispatch(press(8, 2));
    dispatcher.dispatch(release(8, 2));
    t.deepEqual(clicks, ['layer'], 'deferred layer paint wins over document order');
  });

  it('bubbles mouse events and stops on a consuming handler', (t) => {
    const seen: string[] = [];
    const { dispatcher, render } = harness();
    render(
      h(
        Box,
        {
          direction: 'column',
          onMouse: () => {
            seen.push('outer');
          },
        },
        h(
          Box,
          {
            onMouse: () => {
              seen.push('inner');
              return true;
            },
          },
          h(Text, null, 'target'),
        ),
      ),
    );
    t.equal(dispatcher.dispatch(press(2, 0)), true, 'consumed by inner');
    t.deepEqual(seen, ['inner'], 'outer never sees the consumed event');
  });

  it('adds coordinates local to the deepest painted node before bubbling', (t) => {
    let seen: TuiMouseEventLike | null = null;
    const { dispatcher, render } = harness();
    render(
      h(
        Box,
        {
          padding: 1,
          onMouse: (event: TuiMouseEventLike) => {
            seen = event;
          },
        },
        h(Text, null, 'target'),
      ),
    );
    dispatcher.dispatch(press(3, 1));
    t.equal(seen?.localX, 2, 'local column is relative to the text node');
    t.equal(seen?.localY, 0, 'local row is relative to the text node');
  });

  it('moves focus with tab and activates with enter', (t) => {
    const clicks: string[] = [];
    const focusLog: string[] = [];
    const { dispatcher, render } = harness();
    render(
      h(
        Box,
        { direction: 'column' },
        h(
          Clickable,
          {
            id: 'first',
            onClick: () => clicks.push('first'),
            onFocus: () => focusLog.push('+first'),
            onBlur: () => focusLog.push('-first'),
          },
          h(Text, null, 'one'),
        ),
        h(Clickable, { id: 'second', onClick: () => clicks.push('second') }, h(Text, null, 'two')),
      ),
    );
    t.equal(dispatcher.focusedId.get(), null, 'nothing focused initially');
    dispatcher.dispatch(key('tab'));
    t.equal(dispatcher.focusedId.get(), 'first', 'tab focuses the first focusable');
    dispatcher.dispatch(key('tab'));
    t.equal(dispatcher.focusedId.get(), 'second', 'tab advances');
    dispatcher.dispatch(key('tab'));
    t.equal(dispatcher.focusedId.get(), 'first', 'tab wraps');
    t.deepEqual(focusLog, ['+first', '-first', '+first'], 'focus and blur callbacks fire');
    dispatcher.dispatch(key('enter'));
    t.deepEqual(clicks, ['first'], 'enter activates the focused clickable');
    dispatcher.dispatch(key('tab', { shift: true }));
    t.equal(dispatcher.focusedId.get(), 'second', 'shift-tab goes backward');
  });

  it('routes keys to the focused node first and bubbles them', (t) => {
    const seen: string[] = [];
    const { dispatcher, render } = harness();
    render(
      h(
        Box,
        {
          direction: 'column',
          onKey: (event: TuiKeyEventLike) => {
            seen.push(`outer:${event.key}`);
            return true;
          },
        },
        h(
          Clickable,
          {
            id: 'inner',
            onKey: (event: TuiKeyEventLike) => {
              seen.push(`inner:${event.key}`);
              return event.key === 'x';
            },
          },
          h(Text, null, 'thing'),
        ),
      ),
    );
    dispatcher.focusId('inner');
    t.equal(dispatcher.dispatch(key('x')), true, 'focused node consumes');
    t.equal(dispatcher.dispatch(key('y')), true, 'unconsumed key bubbles to the outer handler');
    t.deepEqual(seen, ['inner:x', 'inner:y', 'outer:y'], 'bubble order');
  });

  it('routes unfocused keys only to the last opt-in capture node', (t) => {
    const seen: string[] = [];
    const { dispatcher, render } = harness();
    render(
      h(
        Box,
        { onKey: () => seen.push('ordinary') },
        h(
          Clickable,
          { captureKeys: true, onKey: () => seen.push('first') },
          h(Text, null, 'first'),
        ),
        h(
          Clickable,
          {
            captureKeys: true,
            onKey: () => {
              seen.push('last');
              return true;
            },
          },
          h(Text, null, 'last'),
        ),
      ),
    );
    t.equal(dispatcher.dispatch(key('escape')), true, 'the capture node consumes Escape');
    t.deepEqual(seen, ['last'], 'ordinary and earlier handlers do not capture global keys');
  });

  it('press focuses the nearest focusable ancestor', (t) => {
    const { dispatcher, render } = harness();
    render(
      h(
        Box,
        { direction: 'column' },
        h(Text, null, 'plain'),
        h(Clickable, { id: 'row' }, h(Text, null, 'clicky')),
      ),
    );
    dispatcher.dispatch(press(3, 1));
    t.equal(dispatcher.focusedId.get(), 'row', 'focus follows the mouse press');
    dispatcher.dispatch(press(3, 0));
    t.equal(dispatcher.focusedId.get(), 'row', 'pressing a non-focusable keeps focus');
  });

  it('skips disabled clickables for focus and activation', (t) => {
    const clicks: string[] = [];
    const { dispatcher, render } = harness();
    render(
      h(
        Box,
        { direction: 'column' },
        h(
          Clickable,
          { id: 'off', disabled: true, onClick: () => clicks.push('off') },
          h(Text, null, 'off'),
        ),
        h(Clickable, { id: 'on', onClick: () => clicks.push('on') }, h(Text, null, 'on')),
      ),
    );
    dispatcher.dispatch(key('tab'));
    t.equal(dispatcher.focusedId.get(), 'on', 'disabled node is not in the tab order');
    dispatcher.dispatch(press(1, 0));
    dispatcher.dispatch(release(1, 0));
    t.deepEqual(clicks, [], 'disabled node does not activate');
  });

  it('clears focus when the focused node is removed from the tree', (t) => {
    const { dispatcher, render } = harness();
    const withButton = h(
      Box,
      { direction: 'column' },
      h(Clickable, { id: 'gone', key: 'a' }, h(Text, null, 'x')),
    );
    render(withButton);
    dispatcher.focusId('gone');
    t.equal(dispatcher.focusedId.get(), 'gone', 'focused');
    render(h(Box, { direction: 'column' }, h(Text, { key: 'b' }, 'replaced')));
    t.equal(dispatcher.focusedId.get(), null, 'release clears focus');
  });

  it('clears focus when the retained node becomes disabled', (t) => {
    const { dispatcher, render } = harness();
    render(h(Clickable, { id: 'same', key: 'same' }, h(Text, null, 'enabled')));
    dispatcher.focusId('same');
    render(h(Clickable, { id: 'same', key: 'same', disabled: true }, h(Text, null, 'disabled')));
    t.equal(dispatcher.focusedId.get(), null, 'disabled nodes cannot retain focus');
  });
});
