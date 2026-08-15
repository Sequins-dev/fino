/** @jsxImportSource fino:ui */
import { describe, it } from 'fino:test/test';
import { renderToHtml } from 'fino:ui/html';
import { toHtml, htmlPage } from 'fino:ui/components/html';
import {
  Box,
  Button,
  Checkbox,
  Details,
  Expander,
  FileTree,
  Icon,
  Modal,
  Pagination,
  Panel,
  Select,
  Switch,
  Table,
  Text,
  TextInput,
  VirtualList,
  VirtualScroll,
  VStack,
} from 'fino:ui/components';
import { catalogStories, createGalleryApp, defaultArgs, galleryPage } from 'fino:ui/gallery';
import type { Story } from 'fino:ui/gallery';
import { renderFrame } from 'fino:tty/tui';
import { createRenderer } from 'fino:ui';
import type { VNode } from 'fino:ui';
import { createTerminalRoot, terminalHost } from 'internal:tty/host';
import { layout } from 'internal:tty/layout';
import { lowerTui } from 'internal:tty/lower';
import { TuiDispatcher } from 'internal:tty/events';
import type { TuiMouseEventLike } from 'internal:tty/events';
import { openPty } from 'fino:test/pty';
import { execPath } from 'fino:process';
import { DiskFileSystem } from 'fino:file';

const fs = new DiskFileSystem();
const encoder = new TextEncoder();

describe('fino:ui/components/html', () => {
  it('maps boxes to flexbox divs and titled borders to fieldsets', (t) => {
    const html = renderToHtml(
      toHtml(
        <Box border borderTitle="Session" direction="column" width={20}>
          <Text style={[{ fg: 'cyan' }]}>hello</Text>
        </Box>,
      ),
    );
    t.ok(html.startsWith('<fieldset'), 'titled border becomes a fieldset');
    t.ok(html.includes('<legend>Session</legend>'), 'title becomes the legend');
    t.ok(html.includes('display:flex'), 'boxes are flex containers');
    t.ok(html.includes('width:20ch'), 'cell widths map to ch units');
    t.ok(html.includes('var(--tui-cyan)'), 'named colors map to palette variables');
    t.ok(html.includes('white-space:pre'), 'unwrapped text preserves spacing');
  });

  it('renders panels as titled cards', (t) => {
    const html = renderToHtml(
      toHtml(
        <Panel title="Session">
          <Text>hello</Text>
        </Panel>,
      ),
    );
    t.ok(html.startsWith('<section class="ui-panel"'), 'panel becomes a card section');
    t.ok(html.includes('class="ui-panel-title">Session'), 'title becomes a card header');
    t.ok(html.includes('hello'), 'content renders inside');
  });

  it('renders layers as overlays with optional backdrops', (t) => {
    const html = renderToHtml(
      toHtml(
        <VStack>
          <Text>base</Text>
          <Modal title="Confirm">
            <Text>sure?</Text>
          </Modal>
        </VStack>,
      ),
    );
    t.ok(html.includes('class="ui-overlay"'), 'modal sits on an overlay backdrop');
    t.ok(html.includes('role="dialog"'), 'modal card is a dialog');
    t.ok(html.includes('class="ui-modal-title">Confirm'), 'title renders in the card header');
    t.ok(html.includes('sure?'), 'modal body renders inside');
  });

  it('wraps markup in a page shell with the palette', (t) => {
    const page = htmlPage('<p>hi</p>', { title: 'Demo' });
    t.ok(page.startsWith('<!doctype html>'), 'full document');
    t.ok(page.includes('<title>Demo</title>'), 'title lands');
    t.ok(page.includes('--tui-cyan'), 'palette variables are defined');
    t.ok(page.includes('<p>hi</p>'), 'body markup embedded raw');
  });
});

describe('fino:ui/components/html native lowering', () => {
  it('lowers buttons to real web buttons and drops handlers', (t) => {
    const html = renderToHtml(toHtml(<Button label="Save" onClick={() => {}} />));
    t.equal(html, '<button class="ui-button" type="button">Save</button>', 'styled native button');
    t.ok(!html.includes('[ Save ]'), 'no terminal brackets leak');
    const disabled = renderToHtml(toHtml(<Button label="Off" disabled />));
    t.ok(disabled.includes(' disabled'), 'disabled carries through');
  });

  it('lowers checkboxes to labeled inputs', (t) => {
    const html = renderToHtml(
      toHtml(<Checkbox checked label="Notifications" onChange={() => {}} />),
    );
    t.ok(html.includes('<input type="checkbox"'), 'real checkbox input');
    t.ok(html.includes(' checked'), 'checked state carries');
    t.ok(html.includes('<span>Notifications</span>'), 'label text beside the box');
    t.ok(!html.includes('[x]'), 'no glyph leaks');
    const off = renderToHtml(toHtml(<Checkbox checked={false} label="Off" disabled />));
    t.ok(!off.includes(' checked'), 'unchecked stays unchecked');
    t.ok(off.includes(' disabled'), 'disabled carries');
  });

  it('lowers switches to slider-styled checkboxes', (t) => {
    const html = renderToHtml(toHtml(<Switch on label="Power" onChange={() => {}} />));
    t.ok(html.includes('class="ui-switch"'), 'switch class drives the slider CSS');
    t.ok(html.includes('type="checkbox"'), 'backed by a native checkbox');
    t.ok(html.includes(' checked'), 'on maps to checked');
    t.ok(!html.includes('──●') && !html.includes('●──'), 'no track glyphs leak');
  });

  it('lowers selects to native selects with options', (t) => {
    const options = [
      { key: 'fast', label: 'fast-1' },
      { key: 'smart', label: 'smart-2' },
    ];
    const html = renderToHtml(
      toHtml(
        <Select
          id="model"
          value="smart"
          open={false}
          options={options}
          onOpenChange={() => {}}
          onChange={() => {}}
        />,
      ),
    );
    t.ok(html.includes('<select'), 'native select');
    t.ok(html.includes('<option value="fast">fast-1</option>'), 'options from data');
    t.ok(html.includes('<option value="smart" selected>'), 'value marks the selected option');
    const empty = renderToHtml(
      toHtml(
        <Select
          id="model"
          value={null}
          open={false}
          options={options}
          onOpenChange={() => {}}
          onChange={() => {}}
          placeholder="Pick one"
        />,
      ),
    );
    t.ok(empty.includes('>Pick one</option>'), 'placeholder becomes a disabled option');
  });

  it('lowers details to native disclosure elements', (t) => {
    const open = renderToHtml(
      toHtml(
        <Details title="Advanced" open>
          <Text>secret</Text>
        </Details>,
      ),
    );
    t.ok(open.startsWith('<details'), 'native details element');
    t.ok(open.includes(' open'), 'open state carries');
    t.ok(
      open.includes('<span class="ui-details-title">Advanced</span></summary>'),
      'title lands in the summary row',
    );
    t.ok(open.includes('secret'), 'content renders in the body');
    const closed = renderToHtml(toHtml(<Details title="Advanced" open={false} />));
    t.ok(!closed.includes(' open'), 'closed details stays closed');
    t.ok(!closed.includes('▸'), 'no toggle glyph leaks');
  });

  it('honors expander positions in details markup', (t) => {
    const start = renderToHtml(
      toHtml(
        <Details title="T" open={false}>
          <Text>x</Text>
        </Details>,
      ),
    );
    t.ok(
      /<span class="ui-expander"[^>]*><\/span><span class="ui-details-title">T</.test(start),
      'start places the marker before the title',
    );
    const end = renderToHtml(
      toHtml(
        <Details title="T" open={false} expander="end">
          <Text>x</Text>
        </Details>,
      ),
    );
    t.ok(
      /<span class="ui-details-title">T<\/span><span class="ui-expander"/.test(end),
      'end places the marker after the title',
    );
    const none = renderToHtml(
      toHtml(
        <Details title="T" open={false} expander="none">
          <Text>x</Text>
        </Details>,
      ),
    );
    t.ok(!none.includes('ui-expander'), 'none renders no affordance');
    const opened = renderToHtml(
      toHtml(
        <Details title="T" open>
          <Text>x</Text>
        </Details>,
      ),
    );
    t.ok(opened.includes('ui-expander is-open'), 'open state marks the expander');
  });

  it('lowers icons through the registry', (t) => {
    t.equal(
      renderToHtml(toHtml(<Icon name="folder" />)),
      '<span class="ui-icon" aria-hidden="true">📁</span>',
      'plain icon span from the registry html column',
    );
    const labeled = renderToHtml(toHtml(<Icon name="code" label="Source" />));
    t.ok(labeled.includes('title="Source"'), 'label becomes a title');
    const overridden = renderToHtml(
      toHtml(<Icon name="code" icons={{ code: { tui: 'C', html: 'C' } }} />),
    );
    t.ok(overridden.includes('>C</span>'), 'per-name overrides pick the html column');
  });

  it('lowers tables to real table markup', (t) => {
    const html = renderToHtml(
      toHtml(
        <Table
          columns={[
            { key: 'name', header: 'Name' },
            { key: 'size', header: 'Size', align: 'end' },
          ]}
          rows={[{ name: 'a.ts', size: '120' }]}
          selectedIndex={0}
        />,
      ),
    );
    t.ok(html.startsWith('<table class="ui-table"'), 'real table element');
    t.ok(html.includes('<thead><tr><th>Name</th>'), 'headers in thead');
    t.ok(html.includes('<tbody><tr class="is-selected"><td>a.ts</td>'), 'rows in tbody');
    t.ok(html.includes('text-align:right">Size'), 'end alignment maps to CSS');
  });

  it('lowers file trees to nested native details', (t) => {
    const html = renderToHtml(
      toHtml(
        <FileTree
          nodes={[
            {
              key: 'src',
              label: 'src',
              children: [
                { key: 'a', label: 'a.ts' },
                { key: 'lib', label: 'lib', children: [{ key: 'b', label: 'b.ts' }] },
              ],
            },
            { key: 'readme', label: 'README.md' },
          ]}
          expanded={['src']}
          selectedKey="a"
        />,
      ),
    );
    t.ok(html.includes('<details class="ui-tree-dir" open>'), 'expanded directory is open');
    t.ok(
      html.includes(
        '<summary class="ui-tree-row"><span class="ui-tree-icon">📂</span><span class="ui-tree-name">src</span></summary>',
      ),
      'open directory row is icon then name, with the open folder icon',
    );
    t.ok(
      html.includes('<span class="ui-tree-icon">📁</span><span class="ui-tree-name">lib</span>'),
      'collapsed directory shows the closed folder icon',
    );
    t.ok(
      html.includes(
        'is-selected"><span class="ui-tree-icon">📜</span><span class="ui-tree-name">a.ts</span>',
      ),
      'selected leaf marked, icon before name',
    );
    t.ok(html.includes('README.md'), 'top-level leaf renders');
    t.ok(!html.includes('▾') && !html.includes('▸'), 'no tree glyphs leak');
  });

  it('lowers modals to dialog cards over an overlay', (t) => {
    const html = renderToHtml(
      toHtml(
        <Modal title="Confirm" onDismiss={() => {}}>
          <Text>Delete this?</Text>
        </Modal>,
      ),
    );
    t.ok(html.startsWith('<div class="ui-overlay"'), 'overlay wraps the card');
    t.ok(html.includes('class="ui-modal" role="dialog"'), 'card is a dialog');
    t.ok(html.includes('Delete this?'), 'body renders inside');
  });

  it('lowers pagination to a nav of direct page buttons with ellipses', (t) => {
    const html = renderToHtml(toHtml(<Pagination page={7} pages={20} onChange={() => {}} />));
    t.ok(html.startsWith('<nav class="ui-pager"'), 'pager becomes a nav');
    t.ok(
      html.includes('<span class="ui-pager-ellipsis">…</span>'),
      'skipped pages become ellipsis spans',
    );
    t.ok(
      html.includes('>6<') && html.includes('>7<') && html.includes('>8<'),
      'the sibling window renders',
    );
    t.ok(html.includes('>1<') && html.includes('>20<'), 'first and last page are always shown');
    t.ok(
      /class="ui-button ui-pager-page is-current"[^>]*>7</.test(html),
      'the current page carries the is-current class',
    );
    t.ok(!html.includes('[ 6 ]'), 'no terminal brackets leak');
    const withoutHandler = renderToHtml(
      toHtml(<Pagination page={2} pages={5} onChange={() => {}} />),
    );
    t.ok(!withoutHandler.includes('name="do"'), 'static lowering carries no action wiring');
  });

  it('lowers virtual lists to a scrollable div without wiring a scroll handler by default', (t) => {
    const model = new VirtualScroll();
    model.setCount(50);
    const slice = model.window(5);
    const html = renderToHtml(
      toHtml(
        <VirtualList height={5} window={slice} offset={model.offset}>
          {Array.from({ length: slice.end - slice.start }, (_, i) => (
            <Text key={String(i)}>{`row ${slice.start + i}`}</Text>
          ))}
        </VirtualList>,
      ),
    );
    t.ok(html.startsWith('<div class="ui-virtual"'), 'renders as a plain scrollable div');
    t.ok(!html.includes('data-fi-scroll'), 'no onScroll handler means no scroll wiring');
    t.ok(html.includes('row 0'), 'windowed rows render');
  });
});

describe('fino:ui/components/html actions', () => {
  it('collects actions and routes button clicks', (t) => {
    const actions = new Map<string, (value?: string) => void>();
    let clicks = 0;
    const html = renderToHtml(
      toHtml(<Button label="Save" onClick={() => clicks++} />, {
        actions,
        fields: { story: 'buttons' },
      }),
    );
    t.ok(html.includes('<form method="get" class="ui-action">'), 'button wrapped in a GET form');
    t.ok(html.includes('name="story" value="buttons"'), 'context fields ride along hidden');
    t.ok(html.includes('name="do" value="a0"'), 'submit button carries the action id');
    actions.get('a0')!();
    t.equal(clicks, 1, 'invoking the registered action fires the handler');
    const untouched = renderToHtml(toHtml(<Button label="Save" onClick={() => {}} />));
    t.ok(!untouched.includes('<form'), 'static lowering is unchanged without a collector');
  });

  it('coerces submitted values per role', (t) => {
    const actions = new Map<string, (value?: string) => void>();
    let checked: boolean | null = null;
    let picked: string | null = null;
    const html = renderToHtml(
      toHtml(
        <VStack>
          <Checkbox checked={false} label="notify" onChange={(next) => (checked = next)} />
          <Select
            id="model"
            value={null}
            open={false}
            options={[{ key: 'fast', label: 'fast-1' }]}
            onOpenChange={() => {}}
            onChange={(key) => (picked = key)}
          />
        </VStack>,
        { actions },
      ),
    );
    t.ok(html.includes('name="value"'), 'value-bearing inputs submit under the value field');
    t.ok(html.includes('onchange="this.form.submit()"'), 'inputs auto-submit on change');
    actions.get('a0')!('true');
    t.equal(checked, true, 'checkbox submission coerces to boolean true');
    actions.get('a0')!('false');
    t.equal(checked, false, 'unchecked submission coerces to false');
    actions.get('a1')!('fast');
    t.equal(picked, 'fast', 'select submission passes the option key');
  });

  it('round-trips text input edits through the value contract', (t) => {
    const actions = new Map<string, (value?: string) => void>();
    const got: string[] = [];
    const html = renderToHtml(
      toHtml(<TextInput value="hi" onChange={(next) => got.push(next)} />, { actions }),
    );
    t.ok(html.includes('name="value"'), 'input submits under the value field');
    t.ok(html.includes('onchange="this.form.submit()"'), 'input auto-submits on change');
    t.ok(!html.includes(' disabled'), 'input with onChange is enabled');
    actions.get('a0')!('hello');
    t.deepEqual(got, ['hello'], 'submission delivers the new value to onChange');
    const both = new Map<string, (value?: string) => void>();
    const submits: string[] = [];
    renderToHtml(
      toHtml(<TextInput value="hi" onChange={() => {}} onSubmit={(next) => submits.push(next)} />, {
        actions: both,
      }),
    );
    both.get('a0')!('go');
    t.deepEqual(submits, ['go'], 'onSubmit wins the round trip when both handlers exist');
    const inert = renderToHtml(toHtml(<TextInput value="" placeholder="Type…" />));
    t.ok(inert.includes(' disabled'), 'handler-less input stays non-interactive');
  });

  it('round-trips file tree toggles and selection', (t) => {
    const actions = new Map<string, (value?: string) => void>();
    const toggled: string[] = [];
    const chosen: string[] = [];
    const html = renderToHtml(
      toHtml(
        <FileTree
          nodes={[
            { key: 'src', label: 'src', children: [{ key: 'a', label: 'a.ts' }] },
            { key: 'readme', label: 'README.md' },
          ]}
          expanded={['src']}
          selectedKey="a"
          onToggle={(key) => toggled.push(key)}
          onSelect={(key) => chosen.push(key)}
        />,
        { actions },
      ),
    );
    t.ok(
      html.includes('<button class="ui-tree-icon" name="do" value="a0" aria-label="Collapse">📂'),
      'the directory icon is the toggle affordance',
    );
    t.ok(
      html.includes('<button class="ui-tree-name" name="do" value="a1">src'),
      'the directory name selects',
    );
    t.ok(
      html.includes('class="ui-tree-leaf ui-tree-row is-selected" name="do" value="a2"'),
      'leaf rows are select submit buttons',
    );
    actions.get('a0')!();
    t.deepEqual(toggled, ['src'], 'icon action toggles the directory');
    actions.get('a1')!();
    actions.get('a2')!();
    t.deepEqual(chosen, ['src', 'a'], 'name and leaf actions select their keys');
    const static_ = renderToHtml(
      toHtml(
        <FileTree
          nodes={[{ key: 'src', label: 'src', children: [] }]}
          expanded={[]}
          onToggle={() => {}}
        />,
      ),
    );
    t.ok(!static_.includes('<form'), 'without a collector the native details fallback stays');
    const toggleOnly = new Map<string, (value?: string) => void>();
    const onlyToggled: string[] = [];
    const rowHtml = renderToHtml(
      toHtml(
        <FileTree
          nodes={[{ key: 'src', label: 'src', children: [] }]}
          expanded={[]}
          onToggle={(key) => onlyToggled.push(key)}
        />,
        { actions: toggleOnly },
      ),
    );
    t.ok(
      rowHtml.includes('<button class="ui-tree-name" name="do" value="a0">src'),
      'with only onToggle the name toggles too',
    );
    toggleOnly.get('a0')!();
    t.deepEqual(onlyToggled, ['src'], 'whole-row toggle fires the toggle handler');
  });

  it('emits web action forms when a descriptor is supplied', (t) => {
    const ref = {
      action: 'invoke',
      url: '/?_action=v.invoke',
      view: 'view_1',
      revision: 0,
      request: 'r',
    };
    const tree = toHtml(<Checkbox checked={false} label="n" onChange={() => {}} />, {
      actions: new Map<string, (value?: string) => void>(),
      action: ref,
    });
    t.equal(tree.type, 'form', 'value control wrapped in a form');
    t.equal(tree.props.action, ref.url, 'form action is the descriptor URL');
    t.equal(tree.props['data-fi-action'], 'invoke', 'truthy marker enables client interception');
    const hidden = JSON.stringify(tree);
    for (const field of ['_view', '_ver', '_nonce']) {
      t.ok(hidden.includes(`"${field}"`), `${field} rides as a hidden envelope field`);
    }
    t.equal(tree.props.method, 'post', 'descriptor forms POST');
    t.ok('data-fi-change' in tree.props, 'value forms submit on change through the client');
    t.ok(!JSON.stringify(tree).includes('this.form.submit()'), 'no inline resubmit in web mode');
    const button = toHtml(<Button label="Go" onClick={() => {}} />, {
      actions: new Map<string, (value?: string) => void>(),
      action: ref,
    });
    t.equal(button.props.method, 'post', 'click forms POST the descriptor too');
    t.ok(!('data-fi-change' in button.props), 'click forms submit only on click');
  });

  it('collects standalone expander toggles', (t) => {
    const actions = new Map<string, (value?: string) => void>();
    let open = false;
    const html = renderToHtml(
      toHtml(<Expander open={false} onToggle={(next) => (open = next)} />, { actions }),
    );
    t.ok(
      html.includes('<button class="ui-expander" name="do" value="a0"'),
      'expander renders as a submit affordance',
    );
    actions.get('a0')!();
    t.equal(open, true, 'invoking the action toggles');
  });

  it('round-trips table row selection', (t) => {
    const actions = new Map<string, (value?: string) => void>();
    const picked: number[] = [];
    const html = renderToHtml(
      toHtml(
        <Table
          columns={[{ key: 'name', header: 'Name' }]}
          rows={[{ name: 'a.ts' }, { name: 'b.ts' }]}
          selectedIndex={0}
          onSelectRow={(index) => picked.push(index)}
        />,
        { actions },
      ),
    );
    t.ok(
      html.includes('class="ui-row-select" name="do" value="a0">a.ts'),
      'row cells are submit buttons sharing the row action',
    );
    t.ok(html.includes('value="a1">b.ts'), 'each row registers its own action');
    actions.get('a1')!();
    t.deepEqual(picked, [1], 'row action reports its index');
  });

  it('lowers handler-less controls as non-interactive', (t) => {
    const locked = renderToHtml(toHtml(<Switch on label="Locked on" />));
    t.ok(locked.includes(' disabled'), 'switch without onChange comes out disabled');
    const live = renderToHtml(toHtml(<Switch on label="Power" onChange={() => {}} />));
    t.ok(!live.includes(' disabled'), 'switch with onChange stays enabled');
    const inert = renderToHtml(toHtml(<Button label="Save" />));
    t.ok(inert.includes(' disabled'), 'button without onClick is not an active button');
  });

  it('registers page-button actions and keeps the current page and chevron bounds locked', (t) => {
    const actions = new Map<string, (value?: string) => void>();
    const jumped: number[] = [];
    const html = renderToHtml(
      toHtml(<Pagination page={1} pages={20} onChange={(next) => jumped.push(next)} />, {
        actions,
      }),
    );
    t.ok(html.startsWith('<form'), 'pagination round-trips through an action form');
    t.ok(
      /class="ui-button ui-pager-step"[^>]*disabled/.test(html.split('ui-pager-page')[0]!),
      'prev chevron is disabled on the first page',
    );
    t.ok(
      /class="ui-button ui-pager-page is-current"[^>]*disabled/.test(html),
      'the current page button is inert',
    );
    const jumpTo2 = /name="do" value="(a\d+)">2</.exec(html)![1]!;
    actions.get(jumpTo2)!();
    t.deepEqual(jumped, [2], 'clicking a page button invokes onChange with that page directly');
  });

  it('jumps straight to a middle page, past the ellipsis, in one click', (t) => {
    const actions = new Map<string, (value?: string) => void>();
    const jumped: number[] = [];
    const html = renderToHtml(
      toHtml(<Pagination page={7} pages={20} onChange={(next) => jumped.push(next)} />, {
        actions,
      }),
    );
    t.ok(!/name="do"[^>]*>…</.test(html), 'the ellipsis span carries no action');
    const jumpTo8 = /name="do" value="(a\d+)">8</.exec(html)![1]!;
    actions.get(jumpTo8)!();
    t.deepEqual(jumped, [8], 'a middle page jumps directly, not through the chevrons');
  });

  it('wires VirtualList scroll containers to an action when onScroll is given', (t) => {
    // Mirrors how the real gallery renders interactive views: an actions
    // collector plus a web action descriptor, which is what turns on the
    // client-facing data-fi-action/data-fi-scroll markers (the plain GET
    // fallback used when no descriptor is given intentionally carries none —
    // there is no client JS to intercept it).
    const ref = {
      action: 'invoke',
      url: '/?_action=v.invoke',
      view: 'view_1',
      revision: 0,
      request: 'r',
    };
    const actions = new Map<string, (value?: string) => void>();
    const model = new VirtualScroll();
    model.setCount(500);
    const scrolled: number[] = [];
    const slice = model.window(10);
    const html = renderToHtml(
      toHtml(
        <VirtualList
          height={10}
          window={slice}
          offset={model.offset}
          onScroll={(offset) => scrolled.push(offset)}
        >
          {Array.from({ length: slice.end - slice.start }, (_, i) => (
            <Text key={String(i)}>{`row ${slice.start + i}`}</Text>
          ))}
        </VirtualList>,
        { actions, action: ref },
      ),
    );
    t.ok(html.startsWith('<form'), 'an interactive virtual list rides an action form');
    t.ok(
      /data-fi-action="invoke"/.test(html),
      'a truthy data-fi-action lets the client intercept the form',
    );
    t.ok(html.includes('data-fi-scroll="1"'), 'the scroll container carries the scroll marker');
    t.ok(
      html.includes('data-fi-row-height="'),
      'a row-height rides along for the client to convert scrollTop',
    );
    t.ok(
      /name="_view"/.test(html) && /name="_nonce"/.test(html),
      'the envelope fields ride the form',
    );
    t.ok(/name="value" value="0"/.test(html), 'the current offset seeds the hidden value field');
    const doId = /name="do" value="(a\d+)"/.exec(html)![1]!;
    actions.get(doId)!('20');
    t.deepEqual(
      scrolled,
      [20],
      'invoking the action with a row offset reaches onScroll as a number',
    );
  });

  it('honors semantic border styles on panels', (t) => {
    const groups = catalogStories();
    const doubled = galleryPage(groups, 'panel', { border: 'double' });
    t.ok(doubled.includes('double var(--ui-border)'), 'double maps to a CSS double border');
    const dashed = galleryPage(groups, 'panel', { border: 'ascii' });
    t.ok(dashed.includes('dashed var(--ui-border)'), 'ascii maps to a dashed border');
    t.ok(!dashed.includes('double var(--ui-border)'), 'border styles are distinct');
  });

  it('applies actions over SSE without navigation', async (t) => {
    const app = createGalleryApp();
    const jar = new Map<string, string>();
    const absorb = (response: Response): void => {
      const raw =
        (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
      for (const line of raw) {
        const pair = line.split(';')[0]!;
        const eq = pair.indexOf('=');
        if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
      }
    };
    const cookieHeader = (): string =>
      [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    const loadStory = async (key: string) => {
      const response = (await app.handle(
        new Request(`http://local/?story=${key}`, {
          headers: jar.size > 0 ? { cookie: cookieHeader() } : {},
        }),
      )) as Response;
      absorb(response);
      const html = await response.text();
      return {
        html,
        url: /<form action="([^"]*)"/.exec(html)![1]!.replace(/&amp;/g, '&'),
        view: /name="_view" value="([^"]*)"/.exec(html)![1]!,
        ver: /name="_ver" value="([^"]*)"/.exec(html)![1]!,
        nonce: /name="_nonce" value="([^"]*)"/.exec(html)![1]!,
      };
    };
    const post = (
      fields: Awaited<ReturnType<typeof loadStory>>,
      input: Record<string, string>,
    ): Promise<Response> =>
      app.handle(
        new Request(`http://local${fields.url}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', cookie: cookieHeader() },
          body: JSON.stringify({
            version: 1,
            view: fields.view,
            revision: Number(fields.ver),
            request: fields.nonce,
            input,
          }),
        }),
      ) as Promise<Response>;

    const checkbox = await loadStory('checkbox');
    t.ok(
      /<form[^>]*data-fi-action="[^"]/.test(checkbox.html),
      'action forms carry a truthy data-fi-action for client interception',
    );
    t.ok(checkbox.html.includes('/_fino/client.'), 'the page loads the SSE client');
    t.ok(/class="ui-check"[^>]*checked/.test(checkbox.html), 'checkbox starts checked');
    const doId = /name="do" value="(a\d+)"/.exec(checkbox.html)![1]!;
    const acted = await post(checkbox, { do: doId, value: 'false' });
    t.equal(acted.status, 200, 'action answers 200 — no redirect, no navigation');
    t.ok(
      (acted.headers.get('content-type') ?? '').includes('text/event-stream'),
      'action response is an SSE stream',
    );
    const events = await acted.text();
    t.ok(events.includes('"kind":"render"'), 'the stream pushes a render event');
    t.ok(!events.includes('"checked":true'), 'the pushed tree shows the unchecked state');
    const after = await loadStory('checkbox');
    t.ok(
      !/class="ui-check"[^>]*checked/.test(after.html),
      'story signals persisted the toggle server-side',
    );

    const tabs = await loadStory('tabs');
    t.ok(tabs.html.includes('Active panel: one'), 'first tab active initially');
    const tabId = /name="do" value="(a\d+)">Details</.exec(tabs.html)![1]!;
    const switched = await (await post(tabs, { do: tabId })).text();
    t.ok(switched.includes('Active panel: two'), 'tab switch arrives in the SSE render');
    t.ok(switched.includes('ui-tab is-active'), 'active tab styling updates in the pushed tree');

    const text = await loadStory('text-input');
    t.ok(text.html.includes('value="hello"'), 'text input starts with the story value');
    const textDo = /name="do" value="(a\d+)"/.exec(text.html)![1]!;
    const edited = await (await post(text, { do: textDo, value: 'world' })).text();
    t.ok(edited.includes('world'), 'submitted text arrives in the pushed tree');

    const tree = await loadStory('file-tree');
    t.ok(tree.html.includes('class="ui-tree-dir" open'), 'src starts expanded');
    const treeToggle = /<button class="ui-tree-icon" name="do" value="(a\d+)"/.exec(tree.html)![1]!;
    const collapsed = await (await post(tree, { do: treeToggle })).text();
    t.ok(collapsed.includes('"kind":"render"'), 'tree toggle pushes a render');
    const reloaded = await loadStory('file-tree');
    t.ok(
      !reloaded.html.includes('class="ui-tree-dir" open'),
      'icon-click toggle collapsed src server-side',
    );

    const pagination = await loadStory('pagination');
    t.ok(
      /class="ui-button ui-pager-page is-current"[^>]*>1</.test(pagination.html),
      'pagination starts on page 1',
    );
    const jumpDo = /name="do" value="(a\d+)">2</.exec(pagination.html)![1]!;
    const jumped = await (await post(pagination, { do: jumpDo })).text();
    t.ok(jumped.includes('"kind":"render"'), 'the page jump pushes a render');
    t.ok(
      jumped.includes('"ui-button ui-pager-page is-current"'),
      'a page is marked current in the pushed tree',
    );
    const paginationReloaded = await loadStory('pagination');
    t.ok(
      /class="ui-button ui-pager-page is-current"[^>]*>2</.test(paginationReloaded.html),
      'the page jump persisted server-side',
    );

    const virtual = await loadStory('virtual-list');
    t.ok(virtual.html.includes('data-fi-scroll="1"'), 'the virtual list carries the scroll marker');
    t.ok(
      virtual.html.includes('data-fi-row-height="'),
      'a row height rides along for the client to convert scrollTop',
    );
    t.ok(virtual.html.includes('item 000'), 'the story starts windowed at the top');
    t.ok(!virtual.html.includes('item 020'), 'row 20 is not in the initial window');
    const scrollMarkerAt = virtual.html.indexOf('data-fi-scroll');
    const scrollFormStart = virtual.html.lastIndexOf('<form', scrollMarkerAt);
    const scrollFormEnd = virtual.html.indexOf('</form>', scrollMarkerAt);
    const scrollForm = virtual.html.slice(scrollFormStart, scrollFormEnd);
    const scrollDo = /name="do" value="(a\d+)"/.exec(scrollForm)![1]!;
    const scrolled = await (await post(virtual, { do: scrollDo, value: '20' })).text();
    t.ok(scrolled.includes('"kind":"render"'), 'the scroll action pushes a render');
    t.ok(scrolled.includes('item 020'), 'scrolling moved the window to reveal later rows');
    const virtualReloaded = await loadStory('virtual-list');
    t.ok(virtualReloaded.html.includes('item 020'), 'the scrolled offset persisted server-side');
  });
});

interface LiveStory {
  dispatcher: TuiDispatcher;
  render(tree: VNode): void;
  text(): string[];
}

function liveStory(width = 60, height = 20): LiveStory {
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

function storyByKey(key: string): Story {
  for (const group of catalogStories()) {
    for (const story of group.stories) if (story.key === key) return story;
  }
  throw new Error(`no story ${key}`);
}

function mouse(
  action: 'press' | 'release' | 'wheel',
  button: string,
  x: number,
  y: number,
): TuiMouseEventLike {
  return { type: 'mouse', action, button, x, y, ctrl: false, alt: false, shift: false };
}

describe('fino:ui/gallery', () => {
  it('renders every catalog story in both targets without throwing', (t) => {
    const seen = new Set<string>();
    for (const group of catalogStories()) {
      for (const story of group.stories) {
        t.ok(!seen.has(story.key), `${story.key} is a unique story key`);
        seen.add(story.key);
        const args = defaultArgs(story);
        const tui = renderFrame(story.view(args), { width: 60, height: 20 });
        t.ok(tui.split('\n').length === 20, `${story.key} renders to a TUI frame`);
        const html = renderToHtml(toHtml(story.view(args)));
        t.ok(html.length > 0, `${story.key} renders to HTML`);
      }
    }
  });

  it('scrolls the VirtualList story with the wheel through the TUI dispatcher', (t) => {
    const story = storyByKey('virtual-list');
    const args = defaultArgs(story);
    const app = liveStory();
    app.render(story.view(args));
    t.ok(
      app.text().some((line) => line.includes('item 000')),
      'window starts at the top of the list',
    );
    t.ok(
      app.text().some((line) => line.includes('offset 0/500')),
      'offset readout shows the full extent',
    );
    t.equal(
      app.dispatcher.dispatch(mouse('wheel', 'wheel-down', 2, 2)),
      true,
      'the list consumes the wheel event',
    );
    app.render(story.view(args));
    t.ok(
      app.text().some((line) => line.includes('offset 3/500')),
      'one notch moves the window three rows',
    );
    t.ok(
      app.text().some((line) => line.includes('item 003')),
      'the windowed slice follows the offset',
    );
    app.dispatcher.dispatch(mouse('wheel', 'wheel-up', 2, 2));
    app.render(story.view(args));
    t.ok(
      app.text().some((line) => line.includes('offset 0/500')),
      'wheel-up scrolls back to the top',
    );
  });

  it('removes a tag from the story list through its remover', (t) => {
    const story = storyByKey('tags');
    const args = defaultArgs(story);
    const app = liveStory();
    app.render(story.view(args));
    t.ok(
      app.text().some((line) => line.includes('4 tags')),
      'the story starts with four tags',
    );
    const row = app.text().findIndex((line) => line.includes('alpha'));
    t.ok(row >= 0, 'the alpha tag renders');
    const x = app.text()[row]!.indexOf('×');
    t.ok(x >= 0, 'the removable tag carries a remover');
    app.dispatcher.dispatch(mouse('press', 'left', x, row));
    app.dispatcher.dispatch(mouse('release', 'left', x, row));
    app.render(story.view(args));
    t.ok(
      !app.text().some((line) => line.includes('alpha')),
      'removing deletes the tag from the signal-held list',
    );
    t.ok(
      app.text().some((line) => line.includes('3 tags')),
      'the count reflects the removal',
    );
  });

  it('builds gallery pages with a sidebar and the selected story', (t) => {
    const groups = catalogStories();
    const page = galleryPage(groups, 'checkbox');
    t.ok(page.includes('?story=buttons'), 'sidebar links to stories');
    t.ok(page.includes('Notifications'), 'selected story is rendered');
    t.ok(page.includes('font-weight:bold">Checkbox</a>'), 'active link is bold');
    const fallback = galleryPage(groups, null);
    t.ok(fallback.includes('<h1'), 'no selection falls back to the first story');
  });

  it('drives the TUI gallery in a real pty', async (t) => {
    const dir = `/tmp/fino-gallery-test-${Date.now().toString(36)}`;
    await fs.mkdir(dir);
    const script = `${dir}/gallery.ts`;
    await fs.writeFile(
      script,
      encoder.encode("import { runGalleryTui } from 'fino:ui/gallery';\nawait runGalleryTui();\n"),
    );
    const pty = await openPty(execPath, [script], { cols: 90, rows: 26 });
    try {
      await pty.waitFor((term) => term.text().some((line) => line.includes('Stories')));
      await pty.waitFor((term) => term.text().some((line) => line.includes('Panel')));
      t.ok(
        pty.term.text().some((line) => line.includes('Bordered content')),
        'first story previews',
      );
      await pty.sendKey('down');
      await pty.waitFor((term) => term.text().some((line) => line.includes('grow 2')));
      t.ok(true, 'arrow key changes the story');
      await pty.sendKey('q');
      const code = await pty.waitExit();
      t.equal(code, 0, 'q quits cleanly');
      t.ok(!pty.term.altScreen, 'alternate screen restored on exit');
    } finally {
      await pty.close();
    }
  });

  it('reaches story controls by keyboard in the TUI', async (t) => {
    const dir = `/tmp/fino-gallery-keys-${Date.now().toString(36)}`;
    await fs.mkdir(dir);
    const script = `${dir}/gallery.ts`;
    await fs.writeFile(
      script,
      encoder.encode("import { runGalleryTui } from 'fino:ui/gallery';\nawait runGalleryTui();\n"),
    );
    const pty = await openPty(execPath, [script], { cols: 90, rows: 26 });
    try {
      await pty.waitFor((term) => term.text().some((line) => line.includes('Stories')));
      for (let i = 0; i < 3; i++) await pty.sendKey('down');
      await pty.waitFor((term) => term.text().some((line) => line.includes('[x] Notifications')));
      await pty.sendKey('tab');
      await pty.sendKey('enter');
      await pty.waitFor((term) => term.text().some((line) => line.includes('[ ] Notifications')));
      t.ok(true, 'tab focuses the checkbox and enter toggles it off');
      await pty.sendKey('enter');
      await pty.waitFor((term) => term.text().some((line) => line.includes('[x] Notifications')));
      t.ok(true, 'enter toggles it back on');
      await pty.sendKey('q');
      const code = await pty.waitExit();
      t.equal(code, 0, 'q quits with a focused control');
    } finally {
      await pty.close();
    }
  });
});
