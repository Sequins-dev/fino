/** Co-located preview for bounded virtual-list rendering. @internal */
import { h } from 'fino:ui';
import { Text, VirtualList, VirtualScroll } from 'fino:ui/components';
import type { PreviewGroup } from 'internal:ui/preview';

/** Build the virtual-list preview for a catalog host. */
export function virtualPreviews(): PreviewGroup {
  return {
    title: 'Virtual lists',
    previews: [
      {
        key: 'window',
        name: 'Bounded window',
        view: () => {
          const model = new VirtualScroll();
          model.setCount(10_000);
          model.scrollTo(5_000, 5);
          const window = model.window(5, 1);
          const rows = Array.from({ length: window.end - window.start }, (_, offset) =>
            h(Text, { key: String(window.start + offset) }, `Row ${window.start + offset}`),
          );
          return h(VirtualList, { height: 5, window, offset: model.offset }, ...rows);
        },
      },
    ],
  };
}
