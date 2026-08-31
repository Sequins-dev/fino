/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/virtual.tui — the terminal form of the windowed list.
 *
 * @internal
 */
import { h, mapRenderTargetLowering } from 'fino:ui';
import type { NormalizedChild, VNode } from 'fino:ui';
import { VirtualList } from 'internal:ui/components/virtual';
import type { VirtualListProps } from 'internal:ui/components/virtual';

mapRenderTargetLowering(VirtualList, 'tui', (all: VirtualListProps): VNode => {
  const { children = [], ...props } = all as VirtualListProps & { children?: NormalizedChild[] };
  const { height, window: slice, offset, onMouse, onScroll: _onScroll, ...rest } = props;
  return h(
    'clickable',
    { direction: 'column', height, onMouse, focusable: false, ...rest },
    h(
      'scrollview',
      { height, offset },
      slice.topPad > 0 ? h('spacer', { height: slice.topPad }) : null,
      children,
      slice.bottomPad > 0 ? h('spacer', { height: slice.bottomPad }) : null,
    ),
  );
});
