/** HTML lowerings and styles for menu components. @internal */
import { h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import {
  componentStyleAttrs,
  controlledNativeInput,
  controlledNativeValue,
  nativeAction,
} from 'internal:ui/components/html-runtime';
import {
  ComboBox,
  MenuHeader,
  MenuList,
  MenuRow,
  MenuSeparator,
  Select,
  defaultComboBoxFilter,
  menuWindow,
} from 'internal:ui/components/menu';
import type { MenuItem } from 'internal:ui/components/menu';
import { Popover } from 'internal:ui/components/overlay';
import { mapComponentLowering, registerHtmlCss } from 'internal:ui/components/target';

function rowContent(label: string, detail?: string, glyph?: string): VNode[] {
  const content: VNode[] = [];
  if (glyph !== undefined) content.push(h('span', { className: 'ui-menu-glyph' }, glyph));
  content.push(h('span', null, label));
  if (detail !== undefined) content.push(h('span', { className: 'ui-menu-detail' }, detail));
  return content;
}

mapComponentLowering(MenuRow, 'html', (props) => {
  const { label, detail, glyph, marker: _marker, selected, disabled, onClick } = props;
  return h(
    'div',
    {
      className:
        `ui-menu-item${selected === true ? ' is-selected' : ''}` +
        (disabled === true ? ' is-disabled' : ''),
    },
    nativeAction(
      h('button', componentStyleAttrs(props as Props), ...rowContent(label, detail, glyph)),
      onClick,
      disabled === true,
    ),
  );
});

mapComponentLowering(MenuHeader, 'html', (props) =>
  h('div', componentStyleAttrs(props as Props, 'ui-menu-header'), props.label),
);

mapComponentLowering(MenuSeparator, 'html', (props) =>
  h('hr', componentStyleAttrs(props as Props, 'ui-menu-sep')),
);

mapComponentLowering(MenuList, 'html', (props) => {
  const { items, selectedKey, top, maxRows, marker, onSelect, id } = props;
  const { visible, remaining } = menuWindow(items, top, maxRows);
  return h(
    'div',
    componentStyleAttrs(props as Props, 'ui-menu'),
    ...visible.map((item, index) => {
      if (item.kind === 'header') {
        return h(MenuHeader, { key: `h:${index}`, label: item.label });
      }
      if (item.kind === 'separator') return h(MenuSeparator, { key: `s:${index}` });
      return h(MenuRow, {
        key: item.key,
        id: id === undefined ? undefined : `${id}:${item.key}`,
        label: item.label,
        detail: item.detail,
        glyph: item.glyph,
        marker,
        selected: item.key === selectedKey,
        disabled: item.disabled,
        onClick:
          onSelect === undefined || item.disabled === true ? undefined : () => onSelect(item.key),
      });
    }),
    remaining > 0 ? h('div', { className: 'ui-menu-more' }, `… ${remaining} more`) : null,
  );
});

mapComponentLowering(Select, 'html', (props) => {
  const { value, options, onChange, placeholder, disabled } = props;
  return controlledNativeValue(
    onChange === undefined
      ? undefined
      : (key) => {
          if (
            key !== undefined &&
            options.some((option) => option.key === key && option.disabled !== true)
          ) {
            onChange(key);
          }
        },
    (attrs) => {
      const entries: VNode[] = [];
      if (value === null) {
        entries.push(
          h('option', { value: '', selected: true, disabled: true }, placeholder ?? 'Select…'),
        );
      }
      for (const option of options) {
        entries.push(
          h(
            'option',
            {
              value: option.key,
              selected: option.key === value ? true : undefined,
              disabled: option.disabled === true ? true : undefined,
            },
            option.label,
          ),
        );
      }
      return h(
        'select',
        { ...componentStyleAttrs(props as Props, 'ui-form-field'), ...attrs },
        ...entries,
      );
    },
    { disabled },
  );
});

mapComponentLowering(ComboBox, 'html', (props) => {
  const {
    value,
    options,
    open,
    onOpenChange,
    onInput,
    onSelect,
    activeKey,
    placeholder,
    disabled,
    filter,
    id,
  } = props;
  const filtered = (filter ?? defaultComboBoxFilter)(options, value);
  const inputAttrs = componentStyleAttrs(props as Props, 'ui-form-field');
  Object.assign(inputAttrs, { type: 'text', value, id });
  if (placeholder !== undefined) inputAttrs.placeholder = placeholder;
  const field = controlledNativeInput(
    h('input', inputAttrs),
    onInput === undefined
      ? undefined
      : (next) => {
          const text = next ?? '';
          onInput(text, text.length, null);
          onOpenChange?.(true);
        },
    { disabled },
  );
  const toggle = nativeAction(
    h(
      'button',
      {
        className: 'ui-combo-toggle',
        'aria-label': open ? 'Close options' : 'Open options',
      },
      open ? '▴' : '▾',
    ),
    onOpenChange === undefined ? undefined : () => onOpenChange(!open),
    disabled === true,
  );
  const items: readonly MenuItem[] =
    filtered.length > 0 ? filtered : [{ kind: 'header', label: 'No matches' }];
  return h(
    'div',
    componentStyleAttrs(props as Props, 'ui-combo'),
    field,
    toggle,
    h(
      Popover,
      {
        open,
        anchorId: id,
        onDismiss: onOpenChange === undefined ? undefined : () => onOpenChange(false),
      },
      h(MenuList, {
        items,
        selectedKey: activeKey,
        id: `${id}:menu`,
        onSelect:
          onSelect === undefined
            ? undefined
            : (key) => {
                onSelect(key);
                onOpenChange?.(false);
              },
      }),
    ),
  );
});

registerHtmlCss(`
.ui-menu {
  display: flex; flex-direction: column; min-width: 12rem; padding: 0.25rem;
  border-radius: 0.375rem; background: var(--ui-surface);
}
.ui-menu-item > form { display: contents; }
.ui-menu-item button {
  width: 100%; display: flex; gap: 0.5rem; align-items: center;
  border: 0; border-radius: 0.25rem; padding: 0.4rem 0.5rem;
  background: transparent; color: inherit; text-align: left;
}
.ui-menu-item:not(.is-disabled) button { cursor: pointer; }
.ui-menu-item.is-selected button { background: var(--ui-selected); font-weight: 600; }
.ui-menu-item.is-disabled { opacity: 0.5; }
.ui-menu-detail { margin-left: auto; color: var(--tui-bright-black); }
.ui-menu-header, .ui-menu-more {
  padding: 0.35rem 0.5rem; color: var(--tui-bright-black); font-size: 0.8rem; font-weight: 600;
}
.ui-menu-sep { width: 100%; border: 0; border-top: 1px solid var(--ui-border); }
.ui-combo { display: inline-flex; align-items: stretch; position: relative; }
.ui-combo > form { display: contents; }
.ui-combo-toggle { border: 1px solid var(--ui-border); border-left: 0; background: transparent; }
.ui-combo .ui-popover { top: calc(100% + 0.25rem); left: 0; }
`);
