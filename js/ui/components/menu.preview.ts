/** Co-located previews for menu components. @internal */
import { createSignal, h } from 'fino:ui';
import { ComboBox, MenuList, Select, VStack } from 'fino:ui/components';
import type { PreviewGroup } from 'internal:ui/preview';

const options = [
  { key: 'alpha', label: 'Alpha' },
  { key: 'beta', label: 'Beta' },
  { key: 'gamma', label: 'Gamma', disabled: true },
];

/** Build menu-family previews for a catalog host. */
export function menuPreviews(): PreviewGroup {
  const selected = createSignal<string | null>('alpha');
  const selectOpen = createSignal(false);
  const query = createSignal('');
  const comboOpen = createSignal(false);
  const active = createSignal<string | null>('alpha');
  return {
    title: 'Menus',
    previews: [
      {
        key: 'list',
        name: 'Menu list',
        view: () =>
          h(MenuList, {
            items: [{ kind: 'header', label: 'Commands' }, ...options],
            selectedKey: selected.get(),
            onSelect: (key) => selected.set(key),
          }),
      },
      {
        key: 'select',
        name: 'Select',
        view: () =>
          h(Select, {
            id: 'preview-select',
            value: selected.get(),
            options,
            open: selectOpen.get(),
            onOpenChange: (next) => selectOpen.set(next),
            onChange: (key) => selected.set(key),
          }),
      },
      {
        key: 'combo',
        name: 'ComboBox',
        view: () =>
          h(
            VStack,
            null,
            h(ComboBox, {
              id: 'preview-combo',
              value: query.get(),
              options,
              open: comboOpen.get(),
              activeKey: active.get(),
              onOpenChange: (next) => comboOpen.set(next),
              onActiveChange: (key) => active.set(key),
              onInput: (value) => query.set(value),
              onSelect: (key) =>
                query.set(options.find((option) => option.key === key)?.label ?? ''),
            }),
          ),
      },
    ],
  };
}
