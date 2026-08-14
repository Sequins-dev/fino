/** @jsxImportSource fino:ui */
import { describe, it } from 'fino:test/test';
import { renderToHtml } from 'fino:ui/html';
import { toHtml, htmlPage } from 'fino:ui/components/html';
import {
  Box,
  Button,
  Checkbox,
  Details,
  FileTree,
  Modal,
  Panel,
  Select,
  Switch,
  Table,
  Text,
  VStack,
} from 'fino:ui/components';
import { catalogStories, defaultArgs, galleryPage, runGalleryHtml } from 'fino:ui/gallery';
import { renderFrame } from 'fino:tty/tui';
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
    t.ok(open.includes('<summary>Advanced</summary>'), 'title becomes the summary');
    t.ok(open.includes('secret'), 'content renders in the body');
    const closed = renderToHtml(toHtml(<Details title="Advanced" open={false} />));
    t.ok(!closed.includes(' open'), 'closed details stays closed');
    t.ok(!closed.includes('▸'), 'no toggle glyph leaks');
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
    t.ok(html.includes('<details class="ui-tree-dir"><summary>lib'), 'collapsed directory closed');
    t.ok(html.includes('is-selected">a.ts'), 'selected leaf marked');
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

  it('lowers handler-less controls as non-interactive', (t) => {
    const locked = renderToHtml(toHtml(<Switch on label="Locked on" />));
    t.ok(locked.includes(' disabled'), 'switch without onChange comes out disabled');
    const live = renderToHtml(toHtml(<Switch on label="Power" onChange={() => {}} />));
    t.ok(!live.includes(' disabled'), 'switch with onChange stays enabled');
    const inert = renderToHtml(toHtml(<Button label="Save" />));
    t.ok(inert.includes(' disabled'), 'button without onClick is not an active button');
  });

  it('honors semantic border styles on panels', (t) => {
    const groups = catalogStories();
    const doubled = galleryPage(groups, 'panel', { border: 'double' });
    t.ok(doubled.includes('double var(--ui-border)'), 'double maps to a CSS double border');
    const dashed = galleryPage(groups, 'panel', { border: 'ascii' });
    t.ok(dashed.includes('dashed var(--ui-border)'), 'ascii maps to a dashed border');
    t.ok(!dashed.includes('double var(--ui-border)'), 'border styles are distinct');
  });

  it('round-trips actions over HTTP with 303 redirects', async (t) => {
    const server = runGalleryHtml({ port: 0 });
    await server.ready;
    const base = `http://127.0.0.1:${server.port}`;
    try {
      const page = await (await fetch(`${base}/?story=checkbox`)).text();
      t.ok(/class="ui-check"[^>]*checked/.test(page), 'checkbox starts checked');
      const id = /name="do" value="(a\d+)"/.exec(page)![1]!;
      const redirect = await fetch(`${base}/?story=checkbox&do=${id}&value=false`, {
        redirect: 'manual',
      });
      t.equal(redirect.status, 0, 'action response is a redirect, not a page');
      const followed = await fetch(`${base}/?story=checkbox&do=${id}&value=false`);
      t.equal(followed.redirected, true, 'the 303 is followed back to the story');
      t.equal(followed.status, 200, 'landing page renders');
      const after = await followed.text();
      t.ok(!/class="ui-check"[^>]*checked/.test(after), 'round trip unchecked the checkbox');

      const tabsPage = await (await fetch(`${base}/?story=tabs`)).text();
      t.ok(tabsPage.includes('Active panel: one'), 'first tab active initially');
      const tabId = /name="do" value="(a\d+)">Details</.exec(tabsPage)![1]!;
      const switched = await (await fetch(`${base}/?story=tabs&do=${tabId}`)).text();
      t.ok(switched.includes('Active panel: two'), 'tab switch round-trips through the server');
      t.ok(switched.includes('class="ui-tab is-active">Details'), 'active tab moves');
    } finally {
      await server.close();
    }
  });
});

describe('fino:ui/gallery', () => {
  it('renders every catalog story in both targets without throwing', (t) => {
    for (const group of catalogStories()) {
      for (const story of group.stories) {
        const args = defaultArgs(story);
        const tui = renderFrame(story.view(args), { width: 60, height: 20 });
        t.ok(tui.split('\n').length === 20, `${story.key} renders to a TUI frame`);
        const html = renderToHtml(toHtml(story.view(args)));
        t.ok(html.length > 0, `${story.key} renders to HTML`);
      }
    }
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
});
