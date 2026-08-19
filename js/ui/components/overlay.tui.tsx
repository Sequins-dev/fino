/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/overlay.tui — terminal forms for modals, popovers, toasts, and floating bars.
 *
 * @internal
 */
import { mapRenderTargetLowering } from 'fino:ui';
import type { NormalizedChild, VNode } from 'fino:ui';
import { Box, Clickable, Layer, Text } from 'internal:ui/components/primitives';
import { styles } from 'fino:ui/components/theme';
import { MenuList } from 'internal:ui/components/menu';
import { Panel } from 'internal:ui/components/layout';
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
import type {
  ContextMenuProps,
  FloatingActionBarProps,
  HoverCardProps,
  ModalProps,
  PopoverProps,
  ToastProps,
  ToastStackProps,
  TooltipProps,
} from 'internal:ui/components/overlay';

mapRenderTargetLowering(Modal, 'tui', (all: ModalProps): VNode => {
  const { children = [], ...props } = all as ModalProps & { children?: NormalizedChild[] };
  const { title, onDismiss, width, height } = props;
  return (
    <Layer backdrop width={width} height={height}>
      <Clickable
        direction="column"
        focusable={false}
        captureKeys
        onKey={
          onDismiss
            ? (event) => {
                if (event.key === 'escape') {
                  onDismiss();
                  return true;
                }
                return false;
              }
            : undefined
        }
      >
        <Panel title={title}>{children}</Panel>
      </Clickable>
    </Layer>
  );
});

mapRenderTargetLowering(ContextMenu, 'tui', (all: ContextMenuProps): VNode => {
  const { children = [], ...props } = all as ContextMenuProps & { children?: NormalizedChild[] };
  const { at, items, selectedKey, onSelect, onDismiss, id } = props;
  return (
    <Box>
      <Layer anchor={{ x: 0, y: -1 }} width={9999} height={9999} transparent>
        <Clickable
          focusable={false}
          width={9999}
          height={9999}
          onMouse={(event) => {
            if (event.action === 'press') {
              onDismiss();
              return true;
            }
            return false;
          }}
        />
      </Layer>
      <Layer anchor={at}>
        <Clickable
          focusable={false}
          captureKeys
          onKey={(event) => {
            if (event.key === 'escape') {
              onDismiss();
              return true;
            }
            return false;
          }}
        >
          <Box border paddingX={1}>
            <MenuList items={items} selectedKey={selectedKey} onSelect={onSelect} id={id} />
          </Box>
        </Clickable>
      </Layer>
    </Box>
  );
});

mapRenderTargetLowering(Popover, 'tui', (all: PopoverProps): VNode => {
  const { children = [], ...props } = all as PopoverProps & { children?: NormalizedChild[] };
  const { open, anchorId, onDismiss } = props;
  return (
    <Box>
      {open ? (
        <Layer anchorId={anchorId}>
          <Clickable
            direction="column"
            focusable={false}
            captureKeys
            onKey={
              onDismiss
                ? (event) => {
                    if (event.key === 'escape') {
                      onDismiss();
                      return true;
                    }
                    return false;
                  }
                : undefined
            }
          >
            <Box border paddingX={1} direction="column">
              {children}
            </Box>
          </Clickable>
        </Layer>
      ) : null}
    </Box>
  );
});

mapRenderTargetLowering(Tooltip, 'tui', (all: TooltipProps): VNode => {
  const { children = [], ...props } = all as TooltipProps & { children?: NormalizedChild[] };
  const { text, open, anchorId } = props;
  return (
    <Box>
      {open ? (
        <Layer anchorId={anchorId}>
          <Box border paddingX={1} style={[styles.dim]}>
            <Text>{text}</Text>
          </Box>
        </Layer>
      ) : null}
    </Box>
  );
});

mapRenderTargetLowering(Toast, 'tui', (all: ToastProps): VNode => {
  const { children = [], ...props } = all as ToastProps & { children?: NormalizedChild[] };
  const { message, variant } = props;
  return (
    <Box border borderColor={styles[variant ?? 'info'].fg}>
      <Text>{` ${message} `}</Text>
    </Box>
  );
});

mapRenderTargetLowering(ToastStack, 'tui', (all: ToastStackProps): VNode => {
  const { children = [], ...props } = all as ToastStackProps & { children?: NormalizedChild[] };
  const { toasts } = props;
  return (
    <Box>
      {toasts.length > 0 ? (
        <Layer anchor={{ x: 9999, y: -1 }} placement="bottom-end" transparent>
          <Box direction="column" align="end">
            {toasts.map((entry) => (
              <Toast key={entry.id} message={entry.message} variant={entry.variant} />
            ))}
          </Box>
        </Layer>
      ) : null}
    </Box>
  );
});

mapRenderTargetLowering(HoverCard, 'tui', (all: HoverCardProps): VNode => {
  const { children = [], ...props } = all as HoverCardProps & { children?: NormalizedChild[] };
  const { open, anchorId, title } = props;
  return (
    <Box>
      {open ? (
        <Layer anchorId={anchorId}>
          <Box border paddingX={1} direction="column" gap={1}>
            {title !== undefined ? <Text bold>{title}</Text> : null}
            {children}
          </Box>
        </Layer>
      ) : null}
    </Box>
  );
});

// `Layer` has no notion of "this node's own enclosing container" — anchoring
// always means anchoring to a known hit id (the container must expose one
// via `anchorId`), and its placement model offers only start/end alignment
// relative to that anchor point, never centering. `top-start`/`top-end`
// (rather than `bottom-start`/`bottom-end`) land the bar just inside the
// anchor's bottom edge instead of pushed below it entirely — the closest
// approximation of "floating over the container's bottom" the engine
// currently supports. `'bottom-center'` has no anchored-center counterpart
// to fall back on, so it renders with the same left alignment as
// `'top-start'` here; the web target centers it for real with flexbox.
mapRenderTargetLowering(FloatingActionBar, 'tui', (all: FloatingActionBarProps): VNode => {
  const { children = [], ...props } = all as FloatingActionBarProps & {
    children?: NormalizedChild[];
  };
  const { placement, anchorId } = props;
  // `within` keeps the bar inside its container's rect, and the anchor now
  // carries width, so centering is measured against the container rather
  // than collapsing onto its left edge.
  return (
    <Layer anchorId={anchorId} within placement={placement ?? 'bottom-center'}>
      <Box border paddingX={1} direction="row" gap={1}>
        {children}
      </Box>
    </Layer>
  );
});
