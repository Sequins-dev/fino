import { describe, it } from 'fino:test/test';
import { createSignal, h } from 'fino:ui';
import { Checkbox } from 'fino:ui/components';
import { toHtml } from 'fino:ui/components/html';
import { renderToHtml } from 'fino:ui/html';
import { execPath } from 'fino:process';
import { openPty } from 'fino:test/pty';
import { renderFrame } from 'fino:tty/tui';
import { catalogPreviews, createPreviewApp, defaultArgs, previewPage } from 'fino:ui/preview';
import type { PreviewGroup } from 'fino:ui/preview';
import { validatePreviewGroups } from 'internal:ui/preview';

function cookiesOf(response: Response): string {
  const values =
    (response.headers as Headers & { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  return values
    .map((line) => line.split(';')[0]!)
    .filter((line) => line.length > 0)
    .join('; ');
}

function actionFields(html: string): {
  url: string;
  view: string;
  revision: number;
  request: string;
  action: string;
} {
  return {
    url: /<form action="([^"]*)"/.exec(html)![1]!.replace(/&amp;/g, '&'),
    view: /name="_view" value="([^"]*)"/.exec(html)![1]!,
    revision: Number(/name="_ver" value="([^"]*)"/.exec(html)![1]!),
    request: /name="_nonce" value="([^"]*)"/.exec(html)![1]!,
    action: /name="do" value="(a\d+)"/.exec(html)![1]!,
  };
}

describe('fino:ui/preview catalog', () => {
  it('validates custom catalogs and rejects duplicate global keys', (t) => {
    const valid: PreviewGroup[] = [
      { title: 'One', previews: [{ key: 'one', name: 'One', view: () => h('text', null, '1') }] },
    ];
    t.equal(validatePreviewGroups(valid), valid);
    t.throws(
      () =>
        validatePreviewGroups([
          ...valid,
          { title: 'Two', previews: [{ key: 'one', name: 'Again', view: () => h('text') }] },
        ]),
      /duplicate preview key: one/,
    );
    t.throws(() => validatePreviewGroups([]), /non-empty array/);
    t.throws(
      () => validatePreviewGroups([{ title: 'Empty', previews: [] }]),
      /non-empty previews array/,
    );
  });

  it('renders every family-owned preview through both targets', (t) => {
    const keys = new Set<string>();
    const groups = catalogPreviews();
    t.ok(groups.length >= 14, 'all component families participate');
    for (const group of groups) {
      for (const preview of group.previews) {
        t.ok(!keys.has(preview.key), `${preview.key} is unique`);
        keys.add(preview.key);
        const tree = preview.view(defaultArgs(preview));
        t.equal(renderFrame(tree, { width: 60, height: 20 }).split('\n').length, 20);
        t.ok(renderToHtml(toHtml(tree)).length > 0, `${preview.key} renders to HTML`);
      }
    }
    t.ok(keys.has('icon-button') && keys.has('button'));
    t.ok(keys.has('bar-chart') && keys.has('line-chart'));
  });

  it('builds a static page from the same selected preview and controls', (t) => {
    const page = previewPage(catalogPreviews(), 'panel', { title: 'Build', width: '100' });
    t.ok(page.startsWith('<!doctype html>'));
    t.ok(page.includes('?preview=button'), 'sidebar links share the same catalog');
    t.ok(page.includes('font-weight:bold">Panel</a>'), 'selected entry is marked active');
    t.ok(page.includes('Build'), 'control values reach the selected view');
    t.ok(page.includes('width:60ch'), 'numeric controls use shared parsing and bounds');
  });
});

describe('fino:ui/preview runners', () => {
  it('invokes preview actions and returns the changed tree over SSE', async (t) => {
    const checked = createSignal(true);
    const groups: PreviewGroup[] = [
      {
        title: 'Choices',
        previews: [
          {
            key: 'check',
            name: 'Check',
            view: () =>
              h(Checkbox, {
                checked: checked.get(),
                label: 'Notifications',
                onChange: (next) => checked.set(next),
              }),
          },
        ],
      },
    ];
    const app = createPreviewApp(groups);
    const loaded = (await app.handle(new Request('http://local/?preview=check'))) as Response;
    const cookie = cookiesOf(loaded);
    const html = await loaded.text();
    const fields = actionFields(html);
    t.ok(html.includes('/_fino/client.'), 'page loads the existing server-view client');
    t.ok(/class="ui-check"[^>]*checked/.test(html));

    const acted = (await app.handle(
      new Request(`http://local${fields.url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({
          version: 1,
          view: fields.view,
          revision: fields.revision,
          request: fields.request,
          input: { do: fields.action, value: 'false' },
        }),
      }),
    )) as Response;
    t.equal(acted.status, 200);
    t.ok((acted.headers.get('content-type') ?? '').includes('text/event-stream'));
    const events = await acted.text();
    t.ok(events.includes('"kind":"render"'));
    t.ok(!events.includes('"checked":true'), 'unchecked controls omit the checked attribute');
    t.equal(checked.get(), false, 'the preview handler owns the state transition');
  });

  it('opens and exits the catalog TUI through the root CLI', async (t) => {
    const pty = await openPty(execPath, ['preview'], { cols: 90, rows: 26 });
    try {
      await pty.waitFor((terminal) => terminal.text().some((line) => line.includes('Previews')));
      await pty.waitFor((terminal) => terminal.text().some((line) => line.includes('Panel')));
      await pty.sendKey('q');
      t.equal(await pty.waitExit(), 0);
      // Process exit and the final PTY output are delivered independently.
      await pty.waitFor((terminal) => !terminal.altScreen);
      t.equal(pty.term.altScreen, false, 'terminal state is restored');
    } finally {
      await pty.close();
    }
  });
});
