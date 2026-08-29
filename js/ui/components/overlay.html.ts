/** HTML lowerings and styles for overlay components. @internal */
import { h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import { componentStyleAttrs, nativeAction } from 'internal:ui/components/html-runtime';
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
import { mapComponentLowering, registerHtmlCss } from 'internal:ui/components/target';

function empty(): VNode {
  return h('fragment', null);
}

function dismissButton(onDismiss: (() => void) | undefined): VNode | null {
  if (onDismiss === undefined) return null;
  return nativeAction(
    h('button', { className: 'ui-dismiss', 'aria-label': 'Dismiss' }, '×'),
    onDismiss,
  );
}

function variantClass(variant: StatusVariant | undefined): string {
  return `is-${variant ?? 'info'}`;
}

mapComponentLowering(Modal, 'html', (props, children) => {
  const { title, onDismiss, width, height } = props;
  const modal = componentStyleAttrs(props as Props, 'ui-modal');
  const css = (modal.style ?? {}) as Record<string, string>;
  if (width !== undefined) css.width = `${width}ch`;
  if (height !== undefined) css.height = `${height}lh`;
  if (Object.keys(css).length > 0) modal.style = css;
  return h(
    'div',
    { className: 'ui-overlay' },
    h(
      'section',
      { ...modal, role: 'dialog', 'aria-modal': 'true' },
      dismissButton(onDismiss),
      title === undefined ? null : h('header', { className: 'ui-modal-title' }, title),
      ...children,
    ),
  );
});

mapComponentLowering(ContextMenu, 'html', (props) => {
  const { at, items, selectedKey, onSelect, onDismiss, id } = props;
  const attrs = componentStyleAttrs(props as Props, 'ui-context-menu');
  attrs.style = {
    ...((attrs.style ?? {}) as Record<string, string>),
    left: `${at.x}ch`,
    top: `${at.y}lh`,
  };
  return h(
    'div',
    attrs,
    dismissButton(onDismiss),
    h(MenuList, { items, selectedKey, onSelect, id }),
  );
});

mapComponentLowering(Popover, 'html', (props, children) => {
  const { open, anchorId, onDismiss } = props;
  if (!open) return empty();
  return h(
    'div',
    {
      ...componentStyleAttrs(props as Props, 'ui-popover'),
      'data-anchor-id': anchorId,
    },
    dismissButton(onDismiss),
    ...children,
  );
});

mapComponentLowering(Tooltip, 'html', (props) =>
  props.open
    ? h(
        'span',
        {
          ...componentStyleAttrs(props as Props, 'ui-tooltip'),
          role: 'tooltip',
          'data-anchor-id': props.anchorId,
        },
        props.text,
      )
    : empty(),
);

mapComponentLowering(Toast, 'html', (props) =>
  h(
    'div',
    componentStyleAttrs(props as Props, `ui-toast ${variantClass(props.variant)}`),
    props.message,
  ),
);

mapComponentLowering(ToastStack, 'html', (props) => {
  if (props.toasts.length === 0) return empty();
  return h(
    'div',
    componentStyleAttrs(props as Props, 'ui-toast-stack'),
    ...props.toasts.map((entry) => h(Toast, { key: entry.id, ...entry })),
  );
});

mapComponentLowering(HoverCard, 'html', (props, children) => {
  if (!props.open) return empty();
  return h(
    'div',
    {
      ...componentStyleAttrs(props as Props, 'ui-hover-card'),
      'data-anchor-id': props.anchorId,
    },
    props.title === undefined ? null : h('div', { className: 'ui-hover-card-title' }, props.title),
    ...children,
  );
});

mapComponentLowering(FloatingActionBar, 'html', (props, children) => {
  const placement = props.placement ?? 'bottom-center';
  return h(
    'div',
    {
      ...componentStyleAttrs(props as Props, `ui-fab is-${placement}`),
      'data-anchor-id': props.anchorId,
    },
    ...children,
  );
});

registerHtmlCss(`
.ui-overlay {
  position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center;
  padding: 1rem; background: color-mix(in srgb, var(--tui-bg) 65%, transparent);
}
.ui-modal {
  position: relative; min-width: 18rem; max-width: min(90vw, 64rem); max-height: 90vh;
  overflow: auto; padding: 1rem; border: 1px solid var(--ui-border);
  border-radius: 0.5rem; background: var(--ui-surface);
}
.ui-modal-title, .ui-hover-card-title { margin-bottom: 0.75rem; font-weight: 700; }
.ui-dismiss {
  float: right; border: 0; background: transparent; color: inherit;
  font-size: 1.25rem; cursor: pointer;
}
.ui-popover, .ui-tooltip, .ui-hover-card, .ui-context-menu {
  position: absolute; z-index: 100; border: 1px solid var(--ui-border);
  border-radius: 0.375rem; background: var(--ui-surface); box-shadow: 0 0.5rem 1.5rem #0004;
}
.ui-popover, .ui-hover-card { padding: 0.5rem; }
.ui-tooltip { padding: 0.25rem 0.5rem; color: var(--tui-bright-black); }
.ui-toast-stack {
  position: fixed; z-index: 1100; top: 1rem; right: 1rem;
  display: flex; flex-direction: column; align-items: flex-end; gap: 0.5rem;
}
.ui-toast { width: fit-content; padding: 0.5rem 0.75rem; border: 1px solid currentColor; border-radius: 0.375rem; background: var(--ui-surface); }
.ui-toast.is-success { color: var(--tui-green); }
.ui-toast.is-warning { color: var(--tui-yellow); }
.ui-toast.is-danger { color: var(--tui-red); }
.ui-toast.is-info { color: var(--tui-blue); }
.ui-toast.is-neutral { color: var(--tui-fg); }
.ui-fab { position: absolute; bottom: 0.5rem; display: flex; gap: 0.5rem; }
.ui-fab.is-bottom-start { left: 0.5rem; }
.ui-fab.is-bottom-center { left: 50%; transform: translateX(-50%); }
.ui-fab.is-bottom-end { right: 0.5rem; }
`);
