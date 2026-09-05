/** Live terminal runner for target-neutral preview catalogs. @internal */
import { createSignal, h } from 'fino:ui';
import type { VNode } from 'fino:ui';
import {
  Box,
  Checkbox,
  Clickable,
  HStack,
  ListSelection,
  MenuList,
  Panel,
  Rule,
  Text,
  VStack,
  styles,
} from 'fino:ui/components';
import type { MenuItem } from 'fino:ui/components';
import { getTerminalSize, render } from 'fino:tty/tui';
import { signal as processSignal } from 'fino:process';
import { defaultArgs, findPreview } from 'internal:ui/preview';
import type { ControlValue, Preview, PreviewArgs, PreviewGroup } from 'internal:ui/preview';

function catalogItems(groups: readonly PreviewGroup[]): MenuItem[] {
  return groups.flatMap((group) => [
    { kind: 'header' as const, label: group.title },
    ...group.previews.map((preview) => ({ key: preview.key, label: preview.name })),
  ]);
}

function boundedNumber(value: number, control: { min?: number; max?: number }): number {
  return Math.max(control.min ?? -Infinity, Math.min(control.max ?? Infinity, value));
}

function controlsPane(
  preview: Preview,
  args: PreviewArgs,
  onChange: (name: string, value: ControlValue) => void,
): VNode {
  const controls = Object.entries(preview.controls ?? {}).map(([name, control]) => {
    const label = control.label ?? name;
    const value = args[name] ?? control.default;
    if (control.type === 'boolean') {
      return h(Checkbox, {
        key: name,
        id: `control:${name}`,
        checked: value === true,
        label,
        onChange: (next) => onChange(name, next),
      });
    }
    if (control.type === 'select') {
      const index = control.options.indexOf(String(value));
      const next = control.options[(index + 1) % control.options.length] ?? control.default;
      return h(
        Clickable,
        {
          key: name,
          id: `control:${name}`,
          direction: 'row',
          gap: 1,
          onClick: () => onChange(name, next),
        },
        h(Text, { style: [styles.muted] }, `${label}:`),
        h(Text, { style: [styles.accent] }, `${String(value)} ▸`),
      );
    }
    if (control.type === 'number') {
      const step = control.step ?? 1;
      const current = Number(value);
      return h(
        HStack,
        { key: name, gap: 1 },
        h(Text, { style: [styles.muted] }, `${label}:`),
        h(
          Clickable,
          {
            id: `control:${name}:down`,
            onClick: () => onChange(name, boundedNumber(current - step, control)),
          },
          h(Text, { style: [styles.accent, styles.bold] }, '−'),
        ),
        h(Text, null, String(current)),
        h(
          Clickable,
          {
            id: `control:${name}:up`,
            onClick: () => onChange(name, boundedNumber(current + step, control)),
          },
          h(Text, { style: [styles.accent, styles.bold] }, '+'),
        ),
      );
    }
    return h(
      Clickable,
      {
        key: name,
        id: `control:${name}`,
        direction: 'row',
        gap: 1,
        onKey: (event) => {
          if (event.key === 'backspace') {
            onChange(name, String(value).slice(0, -1));
            return true;
          }
          if (event.text?.length === 1 && event.ctrl !== true && event.alt !== true) {
            onChange(name, String(value) + event.text);
            return true;
          }
          return false;
        },
      },
      h(Text, { style: [styles.muted] }, `${label}:`),
      h(Text, { style: [styles.accent] }, `${String(value)}▏`),
    );
  });
  return h(
    VStack,
    null,
    h(Rule, { style: [styles.dim] }),
    h(Text, { style: [styles.dim, styles.bold] }, 'controls'),
    ...controls,
  );
}

/** Run a validated preview catalog as a retained terminal application. */
export async function runPreviewTui(groups: PreviewGroup[]): Promise<void> {
  const size = createSignal(getTerminalSize());
  const selection = new ListSelection({ maxRows: Math.max(4, size.get().height - 6) });
  selection.setItems(catalogItems(groups));
  const selected = createSignal<string | null>(selection.selectedKey);
  const argsByPreview = new Map<string, ReturnType<typeof createSignal<PreviewArgs>>>();
  const winch = processSignal('SIGWINCH').subscribe(() => {
    const next = getTerminalSize();
    selection.setMaxRows(Math.max(4, next.height - 6));
    size.set(next);
  });
  const argsFor = (preview: Preview): ReturnType<typeof createSignal<PreviewArgs>> => {
    let args = argsByPreview.get(preview.key);
    if (args === undefined) {
      args = createSignal(defaultArgs(preview));
      argsByPreview.set(preview.key, args);
    }
    return args;
  };

  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const view = (): VNode => {
    const preview = findPreview(groups, selected.get());
    const args = preview === undefined ? undefined : argsFor(preview);
    return h(
      HStack,
      { grow: 1, gap: 1, height: size.get().height },
      h(
        Panel,
        { title: 'Previews', width: 24, height: size.get().height },
        h(
          Clickable,
          {
            focusable: false,
            direction: 'column',
            onMouse: (event) => {
              if (event.action !== 'wheel') return false;
              if (selection.move(event.button === 'wheel-up' ? -1 : 1)) {
                selected.set(selection.selectedKey);
              }
              return true;
            },
          },
          h(MenuList, {
            id: 'previews',
            items: selection.items,
            selectedKey: selected.get(),
            top: selection.top,
            maxRows: selection.maxRows,
            onSelect: (key) => {
              selection.selectKey(key);
              selected.set(key);
            },
          }),
        ),
      ),
      h(
        Panel,
        { title: preview?.name ?? '—', grow: 1, height: size.get().height },
        h(
          Box,
          { grow: 1, direction: 'column' },
          preview !== undefined && args !== undefined
            ? preview.view(args.get())
            : h(Text, { style: [styles.muted] }, 'No preview selected'),
        ),
        preview?.controls !== undefined && args !== undefined
          ? controlsPane(preview, args.get(), (name, value) => {
              args.set({ ...args.get(), [name]: value });
            })
          : null,
        h(Text, { style: [styles.dim] }, '↑↓ preview · q quit'),
      ),
    );
  };

  const app = render(view, {
    input: true,
    mouse: true,
    onEvent: (event) => {
      if (event.type !== 'key') return;
      if (event.key === 'q' || (event.key === 'c' && event.ctrl === true)) {
        finish();
        return;
      }
      if (selection.handleKey(event)) selected.set(selection.selectedKey);
    },
  });
  try {
    await done;
  } finally {
    winch.dispose();
    app.stop();
  }
}
