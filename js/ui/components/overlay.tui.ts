/** Terminal lowerings for overlay components. @internal */
import { h } from 'fino:ui';
import type { NormalizedChild, Props, VNode } from 'fino:ui';
import { Box, Clickable, Layer, Text } from 'fino:ui/components';
import { styles } from 'fino:ui/components/theme';
import { dismissOnEscape } from 'internal:ui/components/interaction';
import { Panel } from 'internal:ui/components/layout';
import { MenuList } from 'internal:ui/components/menu';
import {
  ContextMenu,
  FloatingActionBar,
  HoverCard,
  Modal,
  Popover,
  Toast,
  ToastStack,
  Tooltip,
} from 'internal:ui/components/overlay';
import type { StatusVariant } from 'internal:ui/components/overlay';
import { mapComponentLowering } from 'internal:ui/components/target';

interface AnchoredSurfaceOptions {
  anchorId?: string;
  anchor?: { x: number; y: number };
  onDismiss?: () => void;
  box?: Props;
  layer?: Props;
}

/** One anchored-layer composition shared by every terminal floating surface. */
function anchoredSurface(
  options: AnchoredSurfaceOptions,
  children: readonly NormalizedChild[],
): VNode {
  const onKey = dismissOnEscape(options.onDismiss);
  return h(
    Layer,
    { ...options.layer, anchorId: options.anchorId, anchor: options.anchor } as Props,
    h(
      Clickable,
      {
        direction: 'column',
        focusable: false,
        captureKeys: onKey === undefined ? undefined : true,
        onKey,
      },
      h(Box, { border: true, paddingX: 1, direction: 'column', ...options.box }, ...children),
    ),
  );
}

function variantStyle(variant: StatusVariant | undefined): Props['borderColor'] {
  if (variant === 'success') return styles.success.fg;
  if (variant === 'warning') return styles.warning.fg;
  if (variant === 'danger') return styles.danger.fg;
  if (variant === 'neutral') return styles.muted.fg;
  return styles.info.fg;
}

mapComponentLowering(Modal, 'tui', (props, children) => {
  const { title, onDismiss, width, height } = props;
  const onKey = dismissOnEscape(onDismiss);
  return h(
    Layer,
    { backdrop: true, width, height },
    h(
      Clickable,
      {
        direction: 'column',
        focusable: false,
        captureKeys: onKey === undefined ? undefined : true,
        onKey,
      },
      h(Panel, { title }, ...children),
    ),
  );
});

mapComponentLowering(ContextMenu, 'tui', (props) => {
  const { at, items, selectedKey, onSelect, onDismiss, id } = props;
  const dismiss = h(
    Layer,
    { anchor: { x: 0, y: -1 }, width: 9999, height: 9999, transparent: true },
    h(Clickable, {
      focusable: false,
      width: 9999,
      height: 9999,
      onMouse:
        onDismiss === undefined
          ? undefined
          : (event) => {
              if (event.action !== 'press') return false;
              onDismiss();
              return true;
            },
    }),
  );
  return h(
    Box,
    null,
    dismiss,
    anchoredSurface({ anchor: at, onDismiss }, [h(MenuList, { items, selectedKey, onSelect, id })]),
  );
});

mapComponentLowering(Popover, 'tui', (props, children) =>
  props.open
    ? h(
        Box,
        null,
        anchoredSurface({ anchorId: props.anchorId, onDismiss: props.onDismiss }, children),
      )
    : h(Box, null),
);

mapComponentLowering(Tooltip, 'tui', (props) =>
  props.open
    ? h(
        Box,
        null,
        anchoredSurface({ anchorId: props.anchorId, box: { style: [styles.dim] } }, [
          h(Text, null, props.text),
        ]),
      )
    : h(Box, null),
);

mapComponentLowering(Toast, 'tui', (props) =>
  h(
    Box,
    { border: true, borderColor: variantStyle(props.variant), ...props },
    h(Text, null, ` ${props.message} `),
  ),
);

mapComponentLowering(ToastStack, 'tui', (props) => {
  if (props.toasts.length === 0) return h(Box, null);
  return h(
    Box,
    null,
    h(
      Layer,
      { anchor: { x: 9999, y: -1 }, placement: 'bottom-end', transparent: true },
      h(
        Box,
        { direction: 'column', align: 'end' },
        ...props.toasts.map((entry) => h(Toast, { key: entry.id, ...entry })),
      ),
    ),
  );
});

mapComponentLowering(HoverCard, 'tui', (props, children) => {
  if (!props.open) return h(Box, null);
  const content = [
    props.title === undefined ? null : h(Text, { bold: true }, props.title),
    ...children,
  ];
  return h(Box, null, anchoredSurface({ anchorId: props.anchorId, box: { gap: 1 } }, content));
});

mapComponentLowering(FloatingActionBar, 'tui', (props, children) =>
  h(
    Layer,
    {
      anchorId: props.anchorId,
      within: true,
      placement: props.placement ?? 'bottom-center',
    },
    h(Box, { border: true, paddingX: 1, direction: 'row', gap: 1 }, ...children),
  ),
);
