/** @jsxImportSource fino:ui */
import { describe, it } from 'fino:test/test';
import { renderToHtml } from 'fino:ui/html';
import { toHtml, htmlPage } from 'fino:ui/components/html';
import { Box, Button, Checkbox, Modal, Panel, Text, VStack } from 'fino:ui/components';
import { catalogStories, defaultArgs, galleryPage } from 'fino:ui/gallery';
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
        <Panel title="Session" width={20}>
          <Text style={[{ fg: 'cyan' }]}>hello</Text>
        </Panel>,
      ),
    );
    t.ok(html.startsWith('<fieldset'), 'titled border becomes a fieldset');
    t.ok(html.includes('<legend>Session</legend>'), 'title becomes the legend');
    t.ok(html.includes('display:flex'), 'boxes are flex containers');
    t.ok(html.includes('width:20ch'), 'cell widths map to ch units');
    t.ok(html.includes('var(--tui-cyan)'), 'named colors map to palette variables');
    t.ok(html.includes('white-space:pre'), 'unwrapped text preserves spacing');
  });

  it('maps clickables to buttons and drops handler props', (t) => {
    const html = renderToHtml(toHtml(<Button label="Save" onClick={() => {}} />));
    t.ok(html.includes('<button'), 'clickable renders as a button');
    t.ok(!html.includes('onClick'), 'handlers are dropped, not serialized');
    const disabled = renderToHtml(toHtml(<Button label="Off" disabled />));
    t.ok(disabled.includes(' disabled'), 'disabled carries through');
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
    t.ok(html.includes('position:absolute'), 'layer is absolutely positioned');
    t.ok(html.includes('rgb(0 0 0 / 0.45)'), 'backdrop dims what is beneath');
    t.ok(html.includes('<legend>Confirm</legend>'), 'modal panel renders inside');
  });

  it('wraps markup in a page shell with the palette', (t) => {
    const page = htmlPage('<p>hi</p>', { title: 'Demo' });
    t.ok(page.startsWith('<!doctype html>'), 'full document');
    t.ok(page.includes('<title>Demo</title>'), 'title lands');
    t.ok(page.includes('--tui-cyan'), 'palette variables are defined');
    t.ok(page.includes('<p>hi</p>'), 'body markup embedded raw');
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
