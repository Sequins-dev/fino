/** Terminal lowering for a bounded virtual-list viewport. @internal */
import { h } from 'fino:ui';
import type { Props } from 'fino:ui';
import { Clickable, Scroll, Spacer } from 'fino:ui/components';
import { VirtualList } from 'internal:ui/components/virtual';
import { mapComponentLowering } from 'internal:ui/components/target';

mapComponentLowering(VirtualList, 'tui', (props, children) => {
  const { height, window: slice, offset, onMouse, id, ...rest } = props;
  return h(
    Clickable,
    { ...rest, direction: 'column', height, onMouse, focusable: false, id } as Props,
    h(
      Scroll,
      { height, offset },
      slice.topPad > 0 ? h(Spacer, { height: slice.topPad }) : null,
      ...children,
      slice.bottomPad > 0 ? h(Spacer, { height: slice.bottomPad }) : null,
    ),
  );
});
