import { describe, it } from 'fino:test/test';
import { h } from 'fino:ui';
import {
  Blockquote,
  Bold,
  Code,
  Field,
  Fieldset,
  HStack,
  Heading,
  Icon,
  IconButton,
  InlineCode,
  Input,
  Italic,
  Link,
  List,
  Panel,
  Rule,
  Text,
  VStack,
} from 'fino:ui/components';
import { htmlPage, pageCss, toHtml } from 'fino:ui/components/html';
import { renderToHtml } from 'fino:ui/html';
import { iconForm } from 'internal:ui/components/icons';
import { layoutPreviews } from 'internal:ui/components/layout.preview';
import { typographyPreviews } from 'internal:ui/components/typography.preview';
import { iconPreviews } from 'internal:ui/components/icons.preview';
import { defaultArgs, parseArgs } from 'internal:ui/preview';
import { createTuiHarness, plainLine } from './tui-harness.ts';

function html(node: ReturnType<typeof Text>): string {
  return renderToHtml(toHtml(node));
}

describe('fino:ui/components layout family', () => {
  it('composes stacks and titled panels through the terminal target', (t) => {
    const app = createTuiHarness(18, 5);
    app.render(
      h(
        Panel,
        { title: 'Session', width: 18 },
        h(VStack, null, h(Text, null, 'ready'), h(Rule), h(HStack, { gap: 1 }, 'a', 'b')),
      ),
    );
    t.equal(plainLine(app.lines()[0]!), '┌─ Session ──────┐', 'title is painted into the border');
    t.equal(
      plainLine(app.lines()[1]!),
      '│ ready          │',
      'vertical content uses panel padding',
    );
    t.equal(plainLine(app.lines()[2]!), '│ ────────────── │', 'rule fills the inner width');
    t.equal(plainLine(app.lines()[3]!), '│ a b            │', 'horizontal stack preserves its gap');
  });

  it('renders native field semantics and decorates the first primitive control', (t) => {
    const out = html(
      h(
        Field,
        { id: 'email', label: 'Email', hint: 'Work address', error: 'Required', required: true },
        h(Input, { value: '' }),
      ),
    );
    t.ok(out.startsWith('<label class="ui-field ui-field-wrap"'), 'field wraps its control');
    t.ok(out.includes('aria-invalid="true"'), 'error state reaches the native control');
    t.ok(out.includes('aria-describedby="email-hint email-error"'), 'descriptions are linked');
    t.ok(out.includes('role="alert"'), 'error uses an alert role');
  });

  it('uses native fieldset markup and a titled terminal border', (t) => {
    const tree = h(Fieldset, { legend: 'Options', width: 18 }, h(Input, { value: 'yes' }));
    t.ok(html(tree).startsWith('<fieldset class="ui-fieldset"'), 'HTML uses fieldset');
    const app = createTuiHarness(18, 3);
    app.render(tree);
    t.equal(plainLine(app.lines()[0]!), '┌─ Options ──────┐', 'terminal legend sits in the border');
  });
});

describe('fino:ui/components typography family', () => {
  it('preserves nested emphasis as separate terminal style runs', (t) => {
    const app = createTuiHarness(30, 1);
    app.render(h(Text, null, 'plain ', h(Bold, null, 'bold'), ' ', h(Italic, null, 'italic')));
    t.equal(plainLine(app.lines()[0]!), 'plain bold italic', 'content stays in source order');
    const ansi = app.ansi();
    t.ok(ansi.includes('\x1b[1m'), 'nested bold survives lowering');
    t.ok(ansi.includes('\x1b[3m'), 'nested italic survives lowering');
  });

  it('renders heading hierarchy in both targets', (t) => {
    const tree = h(Heading, { level: 1 }, 'Guide');
    const app = createTuiHarness(16, 2);
    app.render(tree);
    t.ok(app.ansi().includes('\x1b[1;36m'), 'terminal heading is bold and accented');
    t.ok(
      [...plainLine(app.lines()[1]!)].every((char) => char === '─'),
      'level one adds a rule',
    );
    t.ok(html(h(Heading, { level: 3 }, 'Guide')).startsWith('<h3'), 'HTML keeps heading level');
  });

  it('renders prose structures and safe links as native HTML', (t) => {
    const prose = html(
      h(
        VStack,
        null,
        h(Blockquote, null, h(Text, null, 'quote')),
        h(List, { items: ['one', h(InlineCode, null, 'two')] }),
        h(Link, { href: 'https://fino.dev' }, 'docs'),
      ),
    );
    t.ok(prose.includes('<blockquote class="ui-blockquote"'), 'blockquote is semantic');
    t.ok(prose.includes('<ul class="ui-list"'), 'list uses native markup');
    t.ok(prose.includes('<code class="ui-inline-code">two</code>'), 'inline code is semantic');
    t.ok(prose.includes('href="https://fino.dev"'), 'safe link keeps its target');
    t.equal(html(h(Link, { href: 'java\tscript:alert(1)' }, 'bad')).includes('href='), false);
  });

  it('routes handler links through the shared HTML action protocol', (t) => {
    let activations = 0;
    const actions = new Map<string, (value?: string) => void>();
    const out = renderToHtml(
      toHtml(h(Link, { onActivate: () => activations++ }, 'run'), { actions }),
    );
    t.ok(out.includes('name="do"'), 'handler link uses an action form');
    actions.get('a0')?.();
    t.equal(activations, 1, 'registered action invokes the handler');
  });

  it('reuses TypeScript highlighting for HTML and terminal code', (t) => {
    const tree = h(Code, {
      code: 'const value = 1;\n// ready',
      language: 'ts',
      showLineNumbers: true,
      filename: 'sample.ts',
    });
    const out = html(tree);
    t.ok(out.includes('class="tok-keyword">const</span>'), 'HTML receives token classes');
    t.ok(out.includes('class="ui-code-num">2</span>'), 'HTML receives line numbers');
    const app = createTuiHarness(32, 6);
    app.render(tree);
    t.ok(app.lines().some((line) => plainLine(line).includes('const value = 1;')));
    t.ok(app.ansi().includes('\x1b[36m'), 'terminal keyword uses the same token classification');
  });
});

describe('fino:ui/components icon family and previews', () => {
  it('resolves semantic icons with override and fallback precedence', (t) => {
    t.equal(iconForm('code', 'tui'), '◆', 'built-in terminal form');
    t.equal(iconForm('missing', 'html'), '📄', 'unknown names use the file icon');
    t.equal(iconForm('code', 'tui', { code: { tui: 'C', html: 'C' } }), 'C', 'override wins');
    t.equal(
      iconForm('missing', 'tui', { file: { tui: 'F', html: 'F' } }),
      'F',
      'caller file override supplies the unknown-name fallback',
    );
  });

  it('renders and activates an accessible icon button in both targets', (t) => {
    let clicks = 0;
    const tree = h(IconButton, {
      id: 'lock',
      icon: 'lock',
      label: 'Lock',
      onClick: () => clicks++,
    });
    const app = createTuiHarness(5, 1);
    app.render(tree);
    t.equal(plainLine(app.lines()[0]!), '∗', 'terminal uses monochrome glyph');
    app.click(0, 0);
    t.equal(clicks, 1, 'terminal click invokes the action');
    const out = html(tree);
    t.ok(out.includes('aria-label="Lock"'), 'HTML button has an accessible name');
    t.ok(out.includes('class="ui-icon"'), 'HTML icon has its own decorative span');
    t.equal(html(h(Icon, { name: 'folder' })).includes('aria-hidden="true"'), true);
  });

  it('keeps family previews co-located and parseable', (t) => {
    const groups = [layoutPreviews(), typographyPreviews(), iconPreviews()];
    t.deepEqual(
      groups.map((group) => group.title),
      ['Layout', 'Typography', 'Icons'],
    );
    const panel = groups[0]!.previews[0]!;
    t.deepEqual(defaultArgs(panel), { title: 'Session', width: 30 });
    t.deepEqual(parseArgs(panel, { title: 'Build', width: '100' }), {
      title: 'Build',
      width: 60,
    });
    t.ok(html(panel.view(defaultArgs(panel))).includes('ui-panel'), 'preview renders to HTML');
  });

  it('aggregates each family stylesheet without duplication', (t) => {
    const css = pageCss();
    for (const selector of ['.ui-panel {', '.ui-heading {', '.ui-icon-button {']) {
      t.equal(css.split(selector).length - 1, 1, `${selector} is registered once`);
    }
    t.ok(htmlPage('ok').includes('.ui-code-content'), 'page shell carries family styles');
  });
});
