/** @jsxImportSource fino:ui */
import { describe, it } from 'fino:test/test';
import { createRenderer, createSignal } from 'fino:ui';
import type { VNode } from 'fino:ui';
import {
  Accordion,
  Badge,
  Box,
  Breadcrumbs,
  Button,
  Card,
  Clickable,
  EmptyState,
  FileTree,
  FloatingActionBar,
  HStack,
  HoverCard,
  KeyHint,
  Pagination,
  Popover,
  ProgressBar,
  SPINNER_FRAMES,
  Spinner,
  Stat,
  StatusDot,
  Steps,
  Table,
  Tag,
  TagGroup,
  Text,
  Timeline,
  Toast,
  ToastStack,
  Tooltip,
  VStack,
  createAccordion,
  createTreeState,
  fileIcon,
  iconForm,
  paginationRange,
} from 'fino:ui/components';
import type { FileTreeNode } from 'fino:ui/components';
import { renderFrame } from 'fino:tty/tui';
import { renderToHtml } from 'fino:ui/html';
import { toHtml } from 'fino:ui/components/html';
import { createTerminalRoot, terminalHost } from 'internal:tty/host';
import { layout } from 'internal:tty/layout';
import { lowerTui } from 'internal:tty/lower';
import { TuiDispatcher } from 'internal:tty/events';
import type { TuiMouseEventLike } from 'internal:tty/events';

function lines(tree: VNode, width: number, height: number): string[] {
  return renderFrame(tree, { width, height }).split('\n');
}

function strip(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '').trimEnd();
}

interface Live {
  dispatcher: TuiDispatcher;
  render(tree: VNode): void;
  text(): string[];
}

function live(width = 30, height = 10): Live {
  const root = createTerminalRoot();
  const renderer = createRenderer(terminalHost());
  const dispatcher = new TuiDispatcher(root);
  let frame: string[] = [];
  return {
    dispatcher,
    render(tree: VNode): void {
      renderer.render(lowerTui(tree), root);
      const laid = layout(root.children[0]!, { width, height });
      frame = laid.rows.map((row) => row.segments.map((s) => s.text).join(''));
    },
    text(): string[] {
      return frame;
    },
  };
}

function click(app: Live, x: number, y: number): void {
  const at = (action: 'press' | 'release'): TuiMouseEventLike => ({
    type: 'mouse',
    action,
    button: 'left',
    x,
    y,
    ctrl: false,
    alt: false,
    shift: false,
  });
  app.dispatcher.dispatch(at('press'));
  app.dispatcher.dispatch(at('release'));
}

describe('fino:ui/components catalog indicators', () => {
  it('renders badges as padded inverse labels', (t) => {
    const frame = lines(<Badge label="beta" variant="warning" />, 10, 1);
    t.equal(strip(frame[0]!), ' beta', 'label padded on both sides');
  });

  it('renders the spinner frame for the tick', (t) => {
    t.equal(SPINNER_FRAMES.length, 10, 'ten braille frames');
    t.equal(strip(lines(<Spinner tick={0} />, 3, 1)[0]!), '⠋', 'first frame at tick 0');
    t.equal(strip(lines(<Spinner tick={13} />, 3, 1)[0]!), '⠸', 'tick wraps modulo frames');
    t.equal(
      strip(lines(<Spinner tick={2} frames={['-', '\\', '|', '/']} />, 3, 1)[0]!),
      '|',
      'caller-supplied frames win',
    );
  });

  it('renders progress cells with an optional percent', (t) => {
    const forty = lines(<ProgressBar value={0.4} width={10} showPercent />, 20, 1);
    t.equal(strip(forty[0]!), '████░░░░░░ 40%', 'four of ten cells filled');
    const empty = lines(<ProgressBar value={0} width={10} />, 20, 1);
    t.equal(strip(empty[0]!), '░░░░░░░░░░', 'zero renders all empty cells');
    const full = lines(<ProgressBar value={1} width={10} showPercent />, 20, 1);
    t.equal(strip(full[0]!), '██████████ 100%', 'one renders all filled cells');
  });

  it('renders key hints with separators', (t) => {
    const frame = lines(
      <KeyHint
        keys={[
          { key: 'y', label: 'approve' },
          { key: 'n', label: 'reject' },
        ]}
      />,
      30,
      1,
    );
    t.equal(strip(frame[0]!), 'y approve · n reject', 'keys and labels joined by the separator');
  });

  it('renders steps with done, current, and upcoming glyphs', (t) => {
    const frame = lines(
      <Steps
        steps={[
          { key: 'plan', label: 'plan' },
          { key: 'build', label: 'build' },
          { key: 'ship', label: 'ship' },
        ]}
        current="build"
      />,
      30,
      1,
    );
    t.equal(strip(frame[0]!), '● plan ── ● build ── ○ ship', 'dots joined by dim connectors');
  });

  it('renders a timeline with connector details', (t) => {
    const frame = lines(
      <Timeline
        entries={[
          { key: 'c', title: 'created', detail: 'by sam', variant: 'success' },
          { key: 'd', title: 'deployed', detail: 'to prod' },
        ]}
      />,
      20,
      5,
    );
    t.equal(strip(frame[0]!), '● created', 'entry dot and title');
    t.equal(strip(frame[1]!), '│  by sam', 'detail beneath a connector');
    t.equal(strip(frame[2]!), '│', 'a connector row separates the two entries');
    t.equal(strip(frame[3]!), '● deployed', 'next entry');
    t.equal(strip(frame[4]!), '   to prod', 'last entry has no trailing connector');
  });
});

describe('fino:ui/components catalog chips and navigation', () => {
  it('renders tags with and without removers', (t) => {
    t.equal(strip(lines(<Tag label="rust" />, 12, 1)[0]!), ' rust', 'plain chip');
    t.equal(
      strip(lines(<Tag label="rust" onRemove={() => {}} />, 12, 1)[0]!),
      ' rust ×',
      'removable chip carries the ×',
    );
    const group = lines(
      <TagGroup>
        <Tag label="a" />
        <Tag label="b" />
      </TagGroup>,
      12,
      1,
    );
    t.equal(strip(group[0]!), ' a   b', 'group lays tags out with a gap');
  });

  it('removes a tag only through its × clickable', (t) => {
    const app = live();
    const removed: string[] = [];
    app.render(
      <TagGroup>
        <Tag label="rust" id="rust" onRemove={() => removed.push('rust')} />
        <Tag label="js" />
      </TagGroup>,
    );
    click(app, 2, 0);
    t.deepEqual(removed, [], 'clicking the label does not remove');
    click(app, 6, 0);
    t.deepEqual(removed, ['rust'], 'clicking the × removes');
  });

  it('renders breadcrumbs and navigates on ancestor clicks only', (t) => {
    const items = [
      { key: 'home', label: 'home' },
      { key: 'src', label: 'src' },
      { key: 'main', label: 'main.ts' },
    ];
    const frame = lines(<Breadcrumbs items={items} />, 24, 1);
    t.equal(strip(frame[0]!), 'home / src / main.ts', 'items joined by slashes');
    const app = live();
    const navigated: string[] = [];
    app.render(<Breadcrumbs items={items} onNavigate={(key) => navigated.push(key)} />);
    click(app, 1, 0);
    click(app, 8, 0);
    t.deepEqual(navigated, ['home', 'src'], 'ancestor clicks navigate');
    click(app, 14, 0);
    t.deepEqual(navigated, ['home', 'src'], 'the current item is not clickable');
  });

  it('pages with chevrons and disables them at the ends', (t) => {
    const app = live();
    const page = createSignal(2);
    const view = (): VNode => (
      <Pagination page={page.get()} pages={3} onChange={(next) => page.set(next)} />
    );
    app.render(view());
    t.equal(
      strip(app.text()[0]!),
      '‹ 1 2 3 ›',
      'pager row: direct page buttons, no ellipses to fit',
    );
    click(app, 0, 0);
    t.equal(page.get(), 1, 'left chevron pages back');
    app.render(view());
    click(app, 0, 0);
    t.equal(page.get(), 1, 'left chevron is disabled at the first page');
    click(app, 8, 0);
    app.render(view());
    click(app, 8, 0);
    t.equal(page.get(), 3, 'right chevron pages forward');
    app.render(view());
    click(app, 8, 0);
    t.equal(page.get(), 3, 'right chevron is disabled at the last page');
  });

  it('jumps to a middle page directly and keeps the current page and ellipses inert', (t) => {
    const app = live(30, 1);
    const page = createSignal(7);
    const view = (): VNode => (
      <Pagination page={page.get()} pages={20} siblings={1} onChange={(next) => page.set(next)} />
    );
    app.render(view());
    // '‹ 1 … 6 7 8 … 20 ›' — indices: ‹0 1sp 2'1' 3sp 4… 5sp 6'6' 7sp 8'7' 9sp 10'8' 11sp 12… 13sp 14-15'20' 16sp 17›
    t.equal(
      strip(app.text()[0]!),
      '‹ 1 … 6 7 8 … 20 ›',
      'window sits around the current page with boundary anchors',
    );
    click(app, 4, 0);
    t.equal(page.get(), 7, 'clicking an ellipsis does nothing');
    click(app, 8, 0);
    t.equal(page.get(), 7, 'clicking the current page does nothing');
    click(app, 10, 0);
    t.equal(page.get(), 8, 'clicking a middle page jumps straight to it');
  });
});

describe('fino:ui/components paginationRange', () => {
  it('windows a middle page with anchors and ellipses on both sides', (t) => {
    t.deepEqual(
      paginationRange(7, 20, 1),
      [1, 'ellipsis', 6, 7, 8, 'ellipsis', 20],
      'siblings around the current page, anchors, and both ellipses',
    );
  });

  it('drops the left ellipsis when the window touches the first page', (t) => {
    t.deepEqual(
      paginationRange(2, 20, 1),
      [1, 2, 3, 'ellipsis', 20],
      'near the start only the right side needs an ellipsis',
    );
  });

  it('drops the right ellipsis when the window touches the last page', (t) => {
    t.deepEqual(
      paginationRange(19, 20, 1),
      [1, 'ellipsis', 18, 19, 20],
      'near the end only the left side needs an ellipsis',
    );
  });

  it('collapses a one-page gap into the page instead of an ellipsis', (t) => {
    t.deepEqual(
      paginationRange(4, 10, 1),
      [1, 2, 3, 4, 5, 'ellipsis', 10],
      'page 2 is the only page hidden left of the window, so it is shown directly',
    );
  });

  it('degenerates to a single page for a one-page (or clamped) pager', (t) => {
    t.deepEqual(paginationRange(1, 1), [1], 'one page needs no anchors or ellipses');
    t.deepEqual(paginationRange(-5, -3), [1], 'negative page and pages clamp to a single page 1');
    t.deepEqual(paginationRange(9, 1), [1], 'an out-of-range page clamps into range');
  });

  it('honors a wider or narrower sibling count', (t) => {
    t.deepEqual(
      paginationRange(5, 10, 0),
      [1, 'ellipsis', 5, 'ellipsis', 10],
      'siblings=0 windows to just the current page',
    );
    t.deepEqual(
      paginationRange(10, 20, 2),
      [1, 'ellipsis', 8, 9, 10, 11, 12, 'ellipsis', 20],
      'siblings=2 widens the window on both sides',
    );
  });
});

describe('fino:ui/components catalog overlays', () => {
  it('anchors a popover beneath its trigger and dismisses on escape', (t) => {
    const app = live(24, 8);
    const dismissed: boolean[] = [];
    app.render(
      <VStack>
        <Clickable id="trigger">
          <Text>menu</Text>
        </Clickable>
        <Popover open anchorId="trigger" onDismiss={() => dismissed.push(true)}>
          <Text>hello</Text>
        </Popover>
      </VStack>,
    );
    t.equal(app.text()[1]!, '┌───────┐', 'border starts under the trigger');
    t.equal(app.text()[2]!, '│ hello │', 'content inside the bordered box');
    app.dispatcher.dispatch({ type: 'key', key: 'escape' });
    t.deepEqual(dismissed, [true], 'escape reaches the popover root');
  });

  it('renders a closed popover as nothing', (t) => {
    const frame = lines(
      <VStack>
        <Clickable id="trigger">
          <Text>menu</Text>
        </Clickable>
        <Popover open={false} anchorId="trigger">
          <Text>hello</Text>
        </Popover>
      </VStack>,
      24,
      4,
    );
    t.equal(strip(frame[1]!), '', 'no overlay painted when closed');
  });

  it('shows a tooltip only while open', (t) => {
    const view = (open: boolean): VNode => (
      <VStack>
        <Clickable id="save">
          <Text>save</Text>
        </Clickable>
        <Tooltip open={open} anchorId="save" text="writes to disk" />
      </VStack>
    );
    const shown = lines(view(true), 24, 5);
    t.equal(strip(shown[1]!), '┌────────────────┐', 'bordered one-liner under the anchor');
    t.equal(strip(shown[2]!), '│ writes to disk │', 'tooltip text');
    const hidden = lines(view(false), 24, 5);
    t.equal(strip(hidden[1]!), '', 'nothing painted when closed');
  });

  it('stacks toasts in the top-right corner', (t) => {
    const single = lines(
      <HStack>
        <Toast message="saved" variant="success" />
      </HStack>,
      12,
      3,
    );
    t.equal(strip(single[0]!), '┌───────┐', 'toast border');
    t.equal(strip(single[1]!), '│ saved │', 'toast message');
    const frame = lines(
      <VStack>
        <Text>app</Text>
        <ToastStack
          toasts={[
            { id: '1', message: 'saved', variant: 'success' },
            { id: '2', message: 'oops', variant: 'danger' },
          ]}
        />
      </VStack>,
      20,
      7,
    );
    t.equal(strip(frame[0]!), 'app        ┌───────┐', 'first toast clamps to the top-right');
    t.equal(strip(frame[1]!), '           │ saved │', 'first toast message');
    t.equal(strip(frame[3]!), '            ┌──────┐', 'narrower toast right-aligns beneath');
    t.equal(strip(frame[4]!), '            │ oops │', 'second toast message');
  });
});

describe('fino:ui/components catalog data views', () => {
  it('renders a table with fitted and fixed columns', (t) => {
    const frame = lines(
      <Table
        columns={[
          { key: 'name', header: 'Name' },
          { key: 'size', header: 'Size', width: 5, align: 'end' },
        ]}
        rows={[
          { name: 'a.ts', size: '120' },
          { name: 'longfile.ts', size: '42' },
        ]}
      />,
      20,
      4,
    );
    t.equal(strip(frame[0]!), 'Name         Size', 'bold header row, end-aligned fixed column');
    t.equal(strip(frame[1]!), '────────────────────', 'dim rule beneath the header');
    t.equal(strip(frame[2]!), 'a.ts          120', 'row cells share the column grid');
    t.equal(strip(frame[3]!), 'longfile.ts    42', 'widest cell sets the fitted column');
  });

  it('truncates cells narrower than an explicit column width', (t) => {
    const frame = lines(
      <Table
        columns={[{ key: 'name', header: 'Name', width: 6 }]}
        rows={[{ name: 'longfile.ts' }]}
      />,
      12,
      3,
    );
    t.equal(strip(frame[2]!), 'longf…', 'cell clipped with an ellipsis');
  });

  it('selects table rows by click', (t) => {
    const app = live();
    const selected: number[] = [];
    const index = createSignal(-1);
    const view = (): VNode => (
      <Table
        columns={[{ key: 'name', header: 'Name' }]}
        rows={[{ name: 'a.ts' }, { name: 'b.ts' }]}
        selectedIndex={index.get()}
        onSelectRow={(next) => {
          selected.push(next);
          index.set(next);
        }}
      />
    );
    app.render(view());
    click(app, 1, 2);
    click(app, 1, 3);
    t.deepEqual(selected, [0, 1], 'row clicks report their index');
    app.render(view());
    t.ok(app.text()[3]!.includes('b.ts'), 'selected row still renders its cells');
  });

  it('renders an indented file tree with registry icons', (t) => {
    const nodes: FileTreeNode[] = [
      {
        key: 'src',
        label: 'src',
        children: [
          { key: 'a', label: 'a.ts' },
          { key: 'lib', label: 'lib', children: [{ key: 'b', label: 'b.ts' }] },
        ],
      },
      { key: 'readme', label: 'README.md' },
    ];
    const frame = lines(<FileTree nodes={nodes} expanded={['src']} selectedKey="a" />, 24, 4);
    t.equal(strip(frame[0]!), '▾ src', 'expanded directory shows the open folder icon');
    t.equal(strip(frame[1]!), '  ◆ a.ts', 'leaf shows its extension icon, indented');
    t.equal(strip(frame[2]!), '  ▸ lib', 'collapsed nested directory shows the closed folder');
    t.equal(strip(frame[3]!), '¶ README.md', 'top-level leaf aligns icon-then-name');
  });

  it('resolves icons by precedence: explicit, user table, built-in, default', (t) => {
    t.equal(fileIcon({ label: 'x.ts' }), 'code', 'built-in extension table');
    t.equal(fileIcon({ label: 'x.ts', icon: 'lock' }), 'lock', 'explicit node icon wins');
    t.equal(fileIcon({ label: 'x.ts' }, { ts: 'image' }), 'image', 'user table beats built-in');
    t.equal(fileIcon({ label: 'x.weird' }), 'file', 'unknown extension defaults');
    t.equal(fileIcon({ label: 'Makefile' }), 'file', 'extensionless defaults');
    t.equal(fileIcon({ label: 'dir', children: [] }), 'folder', 'closed directory');
    t.equal(
      fileIcon({ label: 'dir', children: [] }, undefined, true),
      'folder-open',
      'open directory',
    );
    t.equal(
      fileIcon({ label: 'dir', children: [] }, undefined, true, { open: 'code', closed: 'doc' }),
      'code',
      'folderIcons override the folder names',
    );
    t.equal(iconForm('code', 'tui'), '◆', 'registry resolves the terminal form');
    t.equal(iconForm('code', 'html'), '📜', 'registry resolves the web form');
    t.equal(iconForm('code', 'tui', { code: { tui: 'C', html: 'C' } }), 'C', 'overrides win');
    t.equal(iconForm('no-such-icon', 'tui'), '·', 'unknown names fall back to the file icon');
  });

  it('toggles directories on the icon and selects on the name', (t) => {
    const app = live();
    const tree = createTreeState();
    const picked: string[] = [];
    const nodes: FileTreeNode[] = [
      { key: 'src', label: 'src', children: [{ key: 'a', label: 'a.ts' }] },
      { key: 'readme', label: 'README.md' },
    ];
    const view = (): VNode => (
      <FileTree
        nodes={nodes}
        expanded={tree.expanded.get()}
        onToggle={tree.toggle}
        onSelect={(key) => picked.push(key)}
        id="files"
      />
    );
    app.render(view());
    t.equal(strip(app.text()[0]!), '▸ src', 'starts collapsed with the closed folder icon');
    click(app, 0, 0);
    t.equal(tree.isExpanded('src'), true, 'icon click expands');
    t.deepEqual(picked, [], 'icon click does not select');
    app.render(view());
    t.equal(strip(app.text()[0]!), '▾ src', 'open directory switches to the open folder icon');
    t.equal(strip(app.text()[1]!), '  ◆ a.ts', 'child row appears');
    click(app, 4, 0);
    click(app, 6, 1);
    t.deepEqual(picked, ['src', 'a'], 'name clicks select directory and leaf');
    click(app, 0, 0);
    t.equal(tree.isExpanded('src'), false, 'icon click collapses again');
  });

  it('toggles the whole row when only onToggle exists', (t) => {
    const app = live();
    const tree = createTreeState();
    const nodes: FileTreeNode[] = [{ key: 'src', label: 'src', children: [] }];
    const view = (): VNode => (
      <FileTree nodes={nodes} expanded={tree.expanded.get()} onToggle={tree.toggle} />
    );
    app.render(view());
    click(app, 4, 0);
    t.equal(tree.isExpanded('src'), true, 'name click toggles without a select handler');
  });

  it('renders accordion sections from open keys', (t) => {
    const frame = lines(
      <Accordion
        sections={[
          { key: 'one', title: 'First', content: <Text>alpha</Text> },
          { key: 'two', title: 'Second', content: <Text>bravo</Text> },
        ]}
        openKeys={['one']}
      />,
      20,
      3,
    );
    t.equal(strip(frame[0]!), '▾ First', 'open section summary');
    t.equal(strip(frame[1]!), '  alpha', 'open section content');
    t.equal(strip(frame[2]!), '▸ Second', 'closed section summary');
  });

  it('keeps a single section open through createAccordion(true)', (t) => {
    const app = live();
    const acc = createAccordion(true);
    const view = (): VNode => (
      <Accordion
        sections={[
          { key: 'one', title: 'First', content: <Text>alpha</Text> },
          { key: 'two', title: 'Second', content: <Text>bravo</Text> },
        ]}
        openKeys={acc.openKeys.get()}
        onToggle={acc.toggle}
      />
    );
    app.render(view());
    click(app, 2, 0);
    t.deepEqual(acc.openKeys.get(), ['one'], 'first summary click opens it');
    app.render(view());
    t.ok(app.text()[1]!.includes('alpha'), 'first content shown');
    click(app, 2, 2);
    t.deepEqual(acc.openKeys.get(), ['two'], 'opening the second closes the first');
    app.render(view());
    t.ok(app.text()[2]!.includes('bravo'), 'second content shown');
    t.equal(
      app.text().some((row) => row.includes('alpha')),
      false,
      'first content hidden',
    );
    click(app, 2, 1);
    t.deepEqual(acc.openKeys.get(), [], 'toggling the open section closes it');
  });
});

describe('fino:ui/components catalog display — terminal', () => {
  it('renders a card with an image placeholder, title, subtitle, body, and an actions row', (t) => {
    const frame = lines(
      <Card
        title="Notebook sync"
        subtitle="Last synced 2 minutes ago"
        image={{ src: 'https://example.com/cover.png', alt: 'cover art' }}
        actions={<Text>[ Sync ]</Text>}
      >
        <Text>Body text here</Text>
      </Card>,
      40,
      7,
    );
    t.equal(
      strip(frame[1]!),
      '│ [ cover art ]                        │',
      'image renders as a dim [ alt ] line',
    );
    t.equal(strip(frame[2]!), '│ Notebook sync                        │', 'title row');
    t.equal(strip(frame[3]!), '│ Last synced 2 minutes ago            │', 'subtitle row');
    t.equal(strip(frame[4]!), '│ Body text here                       │', 'body content');
    t.equal(
      strip(frame[5]!),
      '│                             [ Sync ] │',
      'actions right-aligned in a footer row',
    );
  });

  it('omits the image line and header when a card has neither', (t) => {
    const frame = lines(
      <Card>
        <Text>Just body</Text>
      </Card>,
      20,
      3,
    );
    t.equal(
      strip(frame[1]!),
      '│ Just body        │',
      'no image/title/subtitle rows precede the body',
    );
  });

  it('fires a card action button through the terminal dispatcher', (t) => {
    const app = live(30, 6);
    let synced = 0;
    app.render(
      <Card title="Sync" actions={<Button id="sync" label="Sync" onClick={() => synced++} />}>
        <Text>idle</Text>
      </Card>,
    );
    const row = app.text().findIndex((line) => line.includes('Sync ]'));
    t.ok(row >= 0, 'the action button renders in the footer row');
    const x = app.text()[row]!.indexOf('[');
    click(app, x, row);
    t.equal(synced, 1, 'clicking the action button fires its onClick');
  });

  it('renders a stat with a dim label, bold value, and colored trend glyph', (t) => {
    const up = lines(
      <Stat label="Active sessions" value="1,204" hint="last 24h" trend="up" />,
      30,
      3,
    );
    t.equal(strip(up[0]!), 'Active sessions', 'dim label leads');
    t.equal(strip(up[1]!), '1,204 ▲', 'bold value followed by the up trend glyph');
    t.equal(strip(up[2]!), 'last 24h', 'dim hint beneath');
    t.equal(
      strip(lines(<Stat label="x" value="1" trend="down" />, 10, 2)[1]!),
      '1 ▼',
      'down trend glyph',
    );
    t.equal(
      strip(lines(<Stat label="x" value="1" trend="flat" />, 10, 2)[1]!),
      '1 –',
      'flat trend glyph',
    );
    t.equal(
      strip(lines(<Stat label="x" value="1" />, 10, 2)[1]!),
      '1',
      'no trend glyph when trend is omitted',
    );
  });

  it('renders a status dot with an optional label', (t) => {
    t.equal(strip(lines(<StatusDot status="ok" />, 5, 1)[0]!), '●', 'dot alone without a label');
    t.equal(
      strip(lines(<StatusDot status="busy" label="worker-1" />, 20, 1)[0]!),
      '● worker-1',
      'dot plus label',
    );
  });

  it('centers an empty state within its container and fires its action', (t) => {
    const app = live(26, 10);
    let cleared = 0;
    app.render(
      <Box border width={26} height={10}>
        <EmptyState
          grow={1}
          icon="doc"
          title="No results"
          description="Try again"
          action={<Button id="clear" label="Clear" onClick={() => cleared++} />}
        />
      </Box>,
    );
    t.equal(strip(app.text()[1]!), '│           ¶            │', 'registry icon centered');
    t.equal(strip(app.text()[3]!), '│       No results       │', 'title centered');
    t.equal(strip(app.text()[5]!), '│       Try again        │', 'dim description centered');
    const row = app.text().findIndex((line) => line.includes('Clear'));
    t.ok(row >= 0, 'the action renders');
    const x = app.text()[row]!.indexOf('[');
    click(app, x, row);
    t.equal(cleared, 1, 'clicking the empty state action fires its onClick');
  });

  it('shows a hover card with structured content only while open', (t) => {
    const view = (open: boolean): VNode => (
      <VStack gap={1}>
        <Text id="hc-anchor">trigger</Text>
        <HoverCard open={open} anchorId="hc-anchor" title="Release 1.4.0">
          <Text>line one</Text>
        </HoverCard>
      </VStack>
    );
    const shown = lines(view(true), 30, 8);
    t.equal(strip(shown[0]!), 'trigger', 'anchor text renders in normal flow');
    t.equal(strip(shown[1]!), '┌───────────────┐', 'bordered card beneath the anchor');
    t.equal(strip(shown[2]!), '│ Release 1.4.0 │', 'title renders bold inside the card');
    t.equal(strip(shown[3]!), '│               │', 'gap row between title and content');
    t.equal(strip(shown[4]!), '│ line one      │', 'children render inside the card');
    t.equal(strip(shown[5]!), '└───────────────┘', 'card closes with a border');
    const hidden = lines(view(false), 30, 8);
    t.equal(strip(hidden[1]!), '', 'nothing painted when closed');
  });

  it('floats an action bar near the bottom of its anchored container', (t) => {
    const frame = lines(
      <Box id="fab-container" border direction="column" gap={1} width={30} height={8} padding={1}>
        <Text>content</Text>
        <FloatingActionBar anchorId="fab-container" placement="bottom-center">
          <Button label="Jump" onClick={() => {}} />
        </FloatingActionBar>
      </Box>,
      30,
      8,
    );
    t.ok(
      frame.some((line) => strip(line).includes('[ Jump ]')),
      'the bar content paints somewhere in the frame',
    );
    t.equal(
      strip(frame[4]!),
      '┌──────────┐                 │',
      'the bar lands just inside the container, above its last row — overlapping the ' +
        'container border, since Layer anchors to the raw hit rect',
    );
    t.equal(strip(frame[5]!), '│ [ Jump ] │                 │', 'bar content row');
  });
});

describe('fino:ui/components catalog display — html', () => {
  it('renders a card as an article with a real image, heading, and footer actions', (t) => {
    const html = renderToHtml(
      toHtml(
        <Card
          title="Notebook sync"
          subtitle="Last synced 2 minutes ago"
          image={{ src: 'https://example.com/cover.png', alt: 'cover art' }}
          actions={<Button label="Sync" onClick={() => {}} />}
        >
          <Text>Body text here</Text>
        </Card>,
      ),
    );
    t.ok(html.startsWith('<article class="ui-card">'), 'renders a real <article>');
    t.ok(
      html.includes('<img src="https://example.com/cover.png" alt="cover art">'),
      'a real <img> with src/alt',
    );
    t.ok(html.includes('<h3 class="ui-card-title">Notebook sync</h3>'), 'title becomes an <h3>');
    t.ok(
      html.includes('<p class="ui-card-subtitle">Last synced 2 minutes ago</p>'),
      'subtitle becomes a <p>',
    );
    t.ok(html.includes('class="ui-card-actions"'), 'actions render in a footer div');
  });

  it('rejects a javascript: image src instead of emitting a live <img>', (t) => {
    const html = renderToHtml(
      toHtml(<Card title="x" image={{ src: 'javascript:alert(1)', alt: 'evil' }} />),
    );
    t.ok(!html.includes('<img'), 'unsafe image src never reaches markup');
    t.ok(!html.includes('javascript:'), 'the raw scheme does not leak into the page either');
  });

  it('accepts http(s) and relative image sources', (t) => {
    t.ok(
      renderToHtml(
        toHtml(<Card image={{ src: 'https://cdn.example.com/a.png', alt: 'a' }} />),
      ).includes('<img src="https://cdn.example.com/a.png"'),
      'https accepted',
    );
    t.ok(
      renderToHtml(toHtml(<Card image={{ src: '/static/a.png', alt: 'a' }} />)).includes(
        '<img src="/static/a.png"',
      ),
      'relative path accepted',
    );
  });

  it('renders a stat with dt/dd semantics and an accessible trend label', (t) => {
    const html = renderToHtml(
      toHtml(<Stat label="Active sessions" value="1,204" hint="last 24h" trend="up" />),
    );
    t.ok(html.includes('<dl class="ui-stat">'), 'wraps in a definition list');
    t.ok(html.includes('<dt>Active sessions</dt>'), 'label becomes a <dt>');
    t.ok(html.includes('class="ui-stat-value"'), 'value renders in a <dd>');
    t.ok(
      html.includes('aria-label="trending up"'),
      'trend carries a text alternative, not color alone',
    );
    t.ok(html.includes('class="ui-stat-hint"'), 'hint renders in its own <dd>');
    t.ok(
      !renderToHtml(toHtml(<Stat label="x" value="1" />)).includes('ui-stat-trend'),
      'no trend markup when trend is omitted',
    );
  });

  it('conveys status as text on a status dot, never color alone', (t) => {
    const labeled = renderToHtml(toHtml(<StatusDot status="ok" label="worker-1" />));
    t.ok(
      labeled.includes('aria-hidden="true"'),
      'the dot is decorative once a visible label exists',
    );
    t.ok(labeled.includes('>worker-1<'), 'the label renders as visible text');
    const unlabeled = renderToHtml(toHtml(<StatusDot status="busy" />));
    t.ok(
      unlabeled.includes('aria-label="busy"'),
      'without a label the status still names itself for assistive tech',
    );
  });

  it('renders an empty state as a centered flex column with a muted description', (t) => {
    const html = renderToHtml(
      toHtml(
        <EmptyState
          icon="doc"
          title="No results"
          description="Try again"
          action={<Button label="Clear" onClick={() => {}} />}
        />,
      ),
    );
    t.ok(html.includes('class="ui-empty-state"'), 'centered flex column wrapper');
    t.ok(html.includes('class="ui-empty-state-title"'), 'title renders');
    t.ok(html.includes('class="ui-empty-state-desc"'), 'description renders');
    t.ok(html.includes('class="ui-empty-state-action"'), 'action renders in its own wrapper');
  });

  it('renders a hover card with structured content only while open', (t) => {
    const open = renderToHtml(
      toHtml(
        <HoverCard open anchorId="anchor" title="Release 1.4.0">
          <Text>line one</Text>
        </HoverCard>,
      ),
    );
    t.ok(open.includes('class="ui-hover-card"'), 'renders the floating card');
    t.ok(open.includes('class="ui-hover-card-title">Release 1.4.0<'), 'title renders');
    t.ok(open.includes('line one'), 'children render');
    const closed = renderToHtml(
      toHtml(
        <HoverCard open={false} anchorId="anchor">
          <Text>line one</Text>
        </HoverCard>,
      ),
    );
    t.ok(!closed.includes('ui-hover-card'), 'nothing renders when closed');
  });

  it('renders a floating action bar centered or end-aligned with flexbox', (t) => {
    const center = renderToHtml(
      toHtml(
        <FloatingActionBar anchorId="container">
          <Button label="Jump" onClick={() => {}} />
        </FloatingActionBar>,
      ),
    );
    t.ok(center.includes('class="ui-fab ui-fab-center"'), 'default placement centers');
    const end = renderToHtml(
      toHtml(
        <FloatingActionBar anchorId="container" placement="bottom-end">
          <Button label="Jump" onClick={() => {}} />
        </FloatingActionBar>,
      ),
    );
    t.ok(end.includes('class="ui-fab ui-fab-end"'), 'bottom-end end-aligns');
  });
});
