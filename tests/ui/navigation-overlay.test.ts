import { describe, it } from 'fino:test/test';
import { createSignal, h } from 'fino:ui';
import type { VNode } from 'fino:ui';
import {
  Breadcrumbs,
  ComboBox,
  ContextMenu,
  Details,
  ListSelection,
  MenuList,
  Modal,
  Pagination,
  Popover,
  Select,
  TabList,
  ToastStack,
  createAccordion,
  createDisclosure,
  defaultComboBoxFilter,
  paginationRange,
} from 'fino:ui/components';
import { pageCss, toHtml } from 'fino:ui/components/html';
import { renderToHtml } from 'fino:ui/html';
import { dismissOnEscape, moveSelectedKey } from 'internal:ui/components/interaction';
import { disclosurePreviews } from 'internal:ui/components/disclosure.preview';
import { menuPreviews } from 'internal:ui/components/menu.preview';
import { navigationPreviews } from 'internal:ui/components/navigation.preview';
import { overlayPreviews } from 'internal:ui/components/overlay.preview';
import { defaultArgs } from 'internal:ui/preview';
import { createTuiHarness, plainLine } from './tui-harness.ts';

function html(tree: VNode, actions?: Map<string, (value?: string) => void>): string {
  return renderToHtml(toHtml(tree, actions === undefined ? {} : { actions }));
}

describe('shared component interaction mechanics', () => {
  it('moves through enabled keys and centralizes Escape dismissal', (t) => {
    const items = [{ key: 'a' }, { key: 'b', disabled: true }, { key: 'c' }];
    t.equal(moveSelectedKey(items, null, 1), 'a');
    t.equal(moveSelectedKey(items, 'a', 1), 'c');
    t.equal(moveSelectedKey(items, null, -1), 'c');
    let dismissed = 0;
    const onKey = dismissOnEscape(() => dismissed++);
    t.equal(onKey?.({ type: 'key', key: 'enter' }), false);
    t.equal(onKey?.({ type: 'key', key: 'escape' }), true);
    t.equal(dismissed, 1);
  });

  it('keeps one selection window across headers, disabled rows, and paging', (t) => {
    const selection = new ListSelection({ maxRows: 3 });
    selection.setItems([
      { kind: 'header', label: 'Group' },
      { key: 'a', label: 'Alpha' },
      { key: 'b', label: 'Beta', disabled: true },
      { kind: 'separator' },
      { key: 'c', label: 'Charlie' },
      { key: 'd', label: 'Delta' },
    ]);
    t.equal(selection.selectedKey, 'a');
    t.equal(selection.move(1), true);
    t.equal(selection.selectedKey, 'c', 'headers, separators, and disabled rows are skipped');
    t.equal(selection.top, 2, 'the raw-row viewport follows the selected item');
    t.equal(selection.handleKey({ type: 'key', key: 'end' }), true);
    t.equal(selection.selectedKey, 'd');
    t.equal(selection.selectKey('b'), false, 'disabled keys cannot be selected directly');
    selection.setItems([
      { key: 'd', label: 'Delta' },
      { key: 'e', label: 'Echo' },
    ]);
    t.equal(selection.selectedKey, 'd', 'a retained key survives item replacement');
  });

  it('shares state helpers and clamps pagination ranges', (t) => {
    const disclosure = createDisclosure();
    disclosure.toggle();
    t.equal(disclosure.open.get(), true);
    disclosure.set(false);
    t.equal(disclosure.open.get(), false);
    const accordion = createAccordion(true);
    accordion.toggle('a');
    accordion.toggle('b');
    t.deepEqual(accordion.openKeys.get(), ['b']);
    accordion.toggle('b');
    t.deepEqual(accordion.openKeys.get(), []);
    t.deepEqual(paginationRange(7, 20, 1), [1, 'ellipsis', 6, 7, 8, 'ellipsis', 20]);
    t.deepEqual(paginationRange(-2, 0), [1]);
  });
});

describe('disclosure, menu, navigation, and overlay HTML lowerings', () => {
  it('uses one grouped native action for tabs, breadcrumbs, pagination, and select', (t) => {
    const actions = new Map<string, (value?: string) => void>();
    const changes: string[] = [];
    const out = html(
      h(
        'fragment',
        null,
        h(TabList, {
          value: 'a',
          items: [
            { key: 'a', label: 'Alpha' },
            { key: 'b', label: 'Beta' },
          ],
          onChange: (key) => changes.push(`tab:${key}`),
        }),
        h(Breadcrumbs, {
          items: [
            { key: 'home', label: 'Home' },
            { key: 'here', label: 'Here' },
          ],
          onNavigate: (key) => changes.push(`crumb:${key}`),
        }),
        h(Pagination, {
          page: 2,
          pages: 4,
          onChange: (page) => changes.push(`page:${page}`),
        }),
        h(Select, {
          id: 'select',
          value: 'a',
          open: false,
          options: [
            { key: 'a', label: 'Alpha' },
            { key: 'b', label: 'Beta' },
          ],
          onChange: (key) => changes.push(`select:${key}`),
        }),
      ),
      actions,
    );
    t.equal(actions.size, 4, 'each control family registers once, not once per row');
    t.ok(out.includes('role="tab"'));
    t.ok(out.includes('aria-label="breadcrumbs"'));
    t.ok(out.includes('aria-current="page"'));
    t.ok(out.includes('<select'));
    actions.get('a0')?.('b');
    actions.get('a1')?.('home');
    actions.get('a2')?.('4');
    actions.get('a3')?.('b');
    t.deepEqual(changes, ['tab:b', 'crumb:home', 'page:4', 'select:b']);
  });

  it('composes combobox results through the shared Popover and MenuList lowerings', (t) => {
    const out = html(
      h(ComboBox, {
        id: 'search',
        value: 'be',
        open: true,
        activeKey: 'b',
        options: [
          { key: 'a', label: 'Alpha' },
          { key: 'b', label: 'Beta' },
        ],
        onInput: () => {},
        onSelect: () => {},
      }),
    );
    t.ok(out.includes('ui-combo'));
    t.ok(out.includes('ui-popover'), 'combobox reuses the overlay family popover');
    t.ok(out.includes('Beta'));
    t.equal(out.includes('Alpha'), false, 'the shared default filter is applied');
    t.deepEqual(defaultComboBoxFilter([{ key: 'a', label: 'Alpha' }], ' zz '), []);
  });

  it('renders closed surfaces as empty and one set of co-located styles', (t) => {
    t.equal(html(h(Popover, { open: false, anchorId: 'trigger' })), '');
    t.equal(html(h(ToastStack, { toasts: [] })), '');
    const css = pageCss();
    t.equal(css.split('.ui-overlay {').length - 1, 1);
    t.equal(css.split('.ui-tabs {').length - 1, 1);
    t.equal(css.split('.ui-menu {').length - 1, 1);
  });
});

describe('disclosure, menu, navigation, and overlay terminal lowerings', () => {
  it('toggles details and renders navigation primitives', (t) => {
    const app = createTuiHarness(40, 6);
    const open = createSignal(false);
    const view = (): VNode =>
      h(
        'fragment',
        null,
        h(
          Details,
          {
            id: 'details',
            title: 'Advanced',
            open: open.get(),
            onToggle: (next) => open.set(next),
          },
          'Body',
        ),
        h(Pagination, { page: 2, pages: 5, onChange: () => {} }),
      );
    app.render(view());
    t.ok(plainLine(app.lines()[0]!).includes('Advanced'));
    app.click(1, 0);
    t.equal(open.get(), true);
    app.render(view());
    t.ok(app.lines().some((line) => plainLine(line).includes('Body')));
    t.ok(app.lines().some((line) => plainLine(line).includes('‹ 1 2 3')));
  });

  it('routes select movement and Escape through shared interaction helpers', (t) => {
    const app = createTuiHarness(30, 8);
    const value = createSignal<string | null>(null);
    const open = createSignal(false);
    const disabled = createSignal(false);
    const view = (): VNode =>
      h(Select, {
        id: 'select',
        value: value.get(),
        open: open.get(),
        disabled: disabled.get(),
        options: [
          { key: 'a', label: 'Alpha' },
          { key: 'b', label: 'Disabled', disabled: true },
          { key: 'c', label: 'Charlie' },
        ],
        onOpenChange: (next) => open.set(next),
        onChange: (next) => value.set(next),
      });
    app.render(view());
    app.dispatcher.focusNext();
    t.equal(app.key({ key: 'down' }), true);
    t.equal(value.get(), 'a');
    t.equal(open.get(), true);
    app.render(view());
    t.equal(app.key({ key: 'down' }), true);
    t.equal(value.get(), 'c', 'disabled option is skipped');
    t.equal(app.key({ key: 'escape' }), true);
    t.equal(open.get(), false);
    app.render(view());
    t.equal(
      app.lines().some((line) => plainLine(line).includes('Alpha')),
      false,
      'closing removes the anchored menu rows',
    );
    t.equal(app.key({ key: 'escape' }), false, 'the closed popover no longer captures keys');
    disabled.set(true);
    app.render(view());
    t.equal(app.key({ key: 'down' }), false, 'a disabled select remains inert');
    t.equal(open.get(), false);
  });

  it('captures modal Escape and context-menu outside clicks', (t) => {
    const modal = createTuiHarness(30, 6);
    let dismissed = 0;
    modal.render(h(Modal, { title: 'Confirm', onDismiss: () => dismissed++ }, 'Body'));
    t.equal(modal.key({ key: 'escape' }), true);
    t.equal(dismissed, 1);

    const menu = createTuiHarness(30, 8);
    menu.render(
      h(ContextMenu, {
        at: { x: 5, y: 2 },
        items: [{ key: 'copy', label: 'Copy' }],
        onDismiss: () => dismissed++,
      }),
    );
    menu.click(0, 0);
    t.equal(dismissed, 2, 'outside catch layer dismisses the menu');
  });

  it('windows menu rows identically in the terminal target', (t) => {
    const app = createTuiHarness(30, 4);
    app.render(
      h(MenuList, {
        items: [
          { key: 'a', label: 'Alpha' },
          { key: 'b', label: 'Beta' },
          { key: 'c', label: 'Charlie' },
        ],
        top: 1,
        maxRows: 1,
      }),
    );
    t.ok(plainLine(app.lines()[0]!).includes('Beta'));
    t.ok(plainLine(app.lines()[1]!).includes('… 1 more'));
  });
});

describe('interaction-family previews', () => {
  it('keeps every family preview co-located and renderable', (t) => {
    const groups = [disclosurePreviews(), menuPreviews(), navigationPreviews(), overlayPreviews()];
    t.deepEqual(
      groups.map((group) => group.title),
      ['Disclosure', 'Menus', 'Navigation', 'Overlays'],
    );
    for (const group of groups) {
      t.equal(group.previews.length, 3);
      for (const preview of group.previews) {
        t.ok(html(preview.view(defaultArgs(preview))).length > 0, `${group.title}/${preview.key}`);
      }
    }
  });
});
