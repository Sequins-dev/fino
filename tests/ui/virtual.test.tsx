/** @jsxImportSource fino:ui */
import { describe, it } from 'fino:test/test';
import { Text, VirtualList, VirtualScroll } from 'fino:ui/components';
import { renderFrame } from 'fino:tty/tui';

function view(model: VirtualScroll, height: number, count: number): string[] {
  const slice = model.window(height);
  return renderFrame(
    <VirtualList height={height} window={slice} offset={model.offset}>
      {Array.from({ length: slice.end - slice.start }, (_, i) => {
        const index = slice.start + i;
        return <Text key={String(index)}>{`item ${index}`}</Text>;
      })}
    </VirtualList>,
    { width: 12, height },
  )
    .split('\n')
    .map((line) => line.trimEnd());
}

describe('fino:ui/components VirtualScroll', () => {
  it('windows the top of the list with pads covering the rest', (t) => {
    const model = new VirtualScroll();
    model.setCount(100);
    const slice = model.window(10);
    t.equal(slice.start, 0, 'starts at the first item');
    t.equal(slice.end, 12, 'viewport plus overscan');
    t.equal(slice.topPad, 0, 'nothing above');
    t.equal(slice.bottomPad, 88, 'everything else is pad');
    t.equal(model.totalRows, 100, 'uniform estimate totals');
  });

  it('scrolls with clamping and follows the end', (t) => {
    const model = new VirtualScroll();
    model.setCount(50);
    model.scrollBy(20, 10);
    t.equal(model.offset, 20, 'scrolls down');
    t.equal(model.follow, false, 'mid-list is not following');
    model.scrollBy(1000, 10);
    t.equal(model.offset, 40, 'clamped to the max offset');
    t.equal(model.follow, true, 'reaching the end engages follow');
    model.setCount(60);
    const slice = model.window(10);
    t.equal(slice.end, 60, 'follow keeps the window at the new end');
    t.equal(model.offset, 50, 'offset tracked the growth');
    model.scrollBy(-5, 10);
    t.equal(model.follow, false, 'scrolling up breaks follow');
  });

  it('corrects estimates with measured heights', (t) => {
    const model = new VirtualScroll({ estimate: 2 });
    model.setCount(10);
    t.equal(model.totalRows, 20, 'estimated');
    model.setHeight(0, 5);
    t.equal(model.totalRows, 23, 'measured height replaces the estimate');
    model.scrollTo(5, 4);
    const slice = model.window(4, 0);
    t.equal(slice.start, 1, 'the tall first item is fully above');
    t.equal(slice.topPad, 5, 'pad reflects its real height');
  });

  it('routes wheel events three rows per notch', (t) => {
    const model = new VirtualScroll();
    model.setCount(30);
    const wheel = (button: string) =>
      model.handleWheel(
        {
          type: 'mouse',
          action: 'wheel',
          button,
          x: 0,
          y: 0,
          ctrl: false,
          alt: false,
          shift: false,
        },
        10,
      );
    t.equal(wheel('wheel-down'), true, 'consumed');
    t.equal(model.offset, 3, 'scrolled down');
    wheel('wheel-up');
    t.equal(model.offset, 0, 'scrolled back');
  });

  it('renders only the windowed items with exact geometry', (t) => {
    const model = new VirtualScroll();
    model.setCount(100);
    let frame = view(model, 6, 100);
    t.equal(frame[0], 'item 0', 'top of list');
    t.equal(frame[5], 'item 5', 'viewport filled');
    model.scrollTo(50, 6);
    frame = view(model, 6, 100);
    t.equal(frame[0], 'item 50', 'window follows the offset');
    t.equal(frame[5], 'item 55', 'still filled');
    model.scrollToEnd(6);
    frame = view(model, 6, 100);
    t.equal(frame[5], 'item 99', 'end of list lands on the last row');
  });
});
