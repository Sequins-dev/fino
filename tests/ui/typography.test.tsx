/** @jsxImportSource fino:ui */
import { describe, it } from 'fino:test/test';
import { createRenderer } from 'fino:ui';
import type { VNode } from 'fino:ui';
import {
  Blockquote,
  Bold,
  Code,
  HStack,
  Heading,
  InlineCode,
  Italic,
  Link,
  List,
  Text,
} from 'fino:ui/components';
import { renderFrame } from 'fino:tty/tui';
import { renderToHtml } from 'fino:ui/html';
import { PAGE_CSS, toHtml } from 'fino:ui/components/html';
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

describe('fino:ui/components typography — terminal', () => {
  it('renders a level-1 heading bold, accented, with a rule beneath it', (t) => {
    const frame = lines(<Heading level={1}>Guide</Heading>, 20, 2);
    t.equal(strip(frame[0]!), 'Guide', 'heading text renders');
    t.ok(frame[0]!.includes('\x1b[1;36m'), 'level 1 is bold and accent-colored');
    const rule = strip(frame[1]!);
    t.ok(rule.length > 0 && [...rule].every((ch) => ch === '─'), 'rule beneath a level-1 heading');
  });

  it('renders a level-3 heading bold, without accent or a rule', (t) => {
    const frame = lines(<Heading level={3}>Section</Heading>, 20, 2);
    t.equal(strip(frame[0]!), 'Section', 'heading text renders');
    t.ok(frame[0]!.includes('\x1b[1m'), 'still bold');
    t.ok(!frame[0]!.includes('36m'), 'levels below 3 drop the accent color');
    t.equal(strip(frame[1]!), '', 'no rule beneath a lower-level heading');
  });

  it('clamps out-of-range heading levels', (t) => {
    const frame = lines(<Heading level={9 as never}>X</Heading>, 20, 2);
    t.equal(strip(frame[0]!), 'X', 'still renders with a clamped level');
  });

  it('applies the bold/italic SGR codes to Bold and Italic on their own', (t) => {
    t.ok(lines(<Bold>hi</Bold>, 10, 1)[0]!.includes('\x1b[1m'), 'Bold carries the bold SGR code');
    t.ok(
      lines(<Italic>hi</Italic>, 10, 1)[0]!.includes('\x1b[3m'),
      'Italic carries the italic code',
    );
  });

  // `Text` composes nested styled runs (see `internal:tty/layout`'s
  // `collectRuns`), so a `Bold`/`Italic` nested *inside* a `Text` keeps its
  // own styling — same as the web, where `<strong>`/`<em>` compose natively.
  it('keeps nested Bold/Italic styling when nested inside a Text', (t) => {
    const frame = lines(
      <Text>
        plain <Bold>bold</Bold> <Italic>italic</Italic>
      </Text>,
      30,
      1,
    );
    t.equal(strip(frame[0]!), 'plain bold italic', 'text content still renders correctly');
    t.ok(frame[0]!.includes('\x1b[1m'), 'the nested bold styling survives');
  });

  it('keeps distinct styling when Bold/Italic compose as row siblings instead', (t) => {
    const frame = lines(
      <HStack gap={0}>
        <Text>plain </Text>
        <Bold>bold</Bold>
        <Text> </Text>
        <Italic>italic</Italic>
      </HStack>,
      30,
      1,
    );
    t.equal(strip(frame[0]!), 'plain bold italic', 'text reads the same end to end');
    t.ok(frame[0]!.includes('\x1b[1mbold'), 'the bold run keeps its own SGR code as a row sibling');
    t.ok(
      frame[0]!.includes('\x1b[3mitalic'),
      'the italic run keeps its own SGR code as a row sibling',
    );
  });

  it('renders an href-only link as styled, non-interactive text', (t) => {
    const frame = lines(<Link href="https://fino.dev">docs</Link>, 20, 1);
    t.equal(strip(frame[0]!), 'docs', 'link text renders');
    t.ok(frame[0]!.includes('\x1b[4;36m'), 'underline + accent styling');
    t.ok(!frame[0]!.includes('\x1b]8'), 'no OSC 8 hyperlink escape leaks into the frame');
  });

  it('never emits an OSC 8 hyperlink for a dangerous href, since the terminal never emits one at all', (t) => {
    const frame = lines(<Link href="javascript:alert(1)">click me</Link>, 20, 1);
    t.equal(strip(frame[0]!), 'click me', 'text still renders, styled');
    t.ok(!frame[0]!.includes('\x1b]8'), 'no OSC 8 escape for any href, safe or not');
  });

  it('fires onActivate for a handler link on click', (t) => {
    const app = live();
    let activated = 0;
    app.render(
      <Link id="l" onActivate={() => activated++}>
        run
      </Link>,
    );
    t.equal(strip(app.text()[0]!), 'run', 'handler link renders its label');
    click(app, 1, 0);
    t.equal(activated, 1, 'click fires onActivate');
  });

  it('renders a blockquote with a gutter and dimmed content', (t) => {
    const frame = lines(
      <Blockquote>
        <Text>quoted</Text>
      </Blockquote>,
      20,
      1,
    );
    t.equal(strip(frame[0]!), '│ quoted', 'gutter then content');
  });

  it('gives every blockquote child its own gutter row', (t) => {
    const frame = lines(
      <Blockquote>
        <Text>Measure twice, cut once.</Text>
        <Text>— every carpenter, ever</Text>
      </Blockquote>,
      30,
      2,
    );
    t.equal(strip(frame[0]!), '│ Measure twice, cut once.', 'first line carries the gutter');
    t.equal(
      strip(frame[1]!),
      '│ — every carpenter, ever',
      'second line carries its own gutter too',
    );
  });

  it('renders an unordered list with bullet markers', (t) => {
    const frame = lines(<List items={['first', 'second']} />, 20, 2);
    t.equal(strip(frame[0]!), '• first', 'bullet marker on the first item');
    t.equal(strip(frame[1]!), '• second', 'bullet marker on the second item');
  });

  it('renders an ordered list with numbered markers', (t) => {
    const frame = lines(<List ordered items={['a', 'b', 'c']} />, 20, 3);
    t.equal(strip(frame[0]!), '1. a', 'first item is numbered 1');
    t.equal(strip(frame[1]!), '2. b', 'second item is numbered 2');
    t.equal(strip(frame[2]!), '3. c', 'third item is numbered 3');
  });

  it('hangs wrapped list item lines past the marker instead of repeating it', (t) => {
    const frame = lines(<List items={['This item wraps onto a hanging indent line']} />, 16, 3);
    t.ok(strip(frame[0]!).startsWith('• '), 'the marker appears once, on the first row');
    t.ok(!strip(frame[1]!).includes('•'), 'the marker does not repeat on continuation rows');
    t.ok(strip(frame[1]!).startsWith('  '), 'continuation rows indent to align under the text');
  });

  it('highlights a TS code block and numbers its lines', (t) => {
    const frame = lines(
      <Code code={'const x = 1;\nconst y = 2;'} language="ts" showLineNumbers />,
      40,
      4,
    );
    // Code renders inside a bordered box, so row 0 is the top border and
    // content starts at row 1.
    const first = strip(frame[1]!);
    const second = strip(frame[2]!);
    t.ok(
      first.includes('1') && first.includes('const x = 1;'),
      'first line carries its number and code',
    );
    t.ok(
      second.includes('2') && second.includes('const y = 2;'),
      'second line carries its number and code',
    );
  });

  it('renders a code block without a gutter by default', (t) => {
    const frame = lines(<Code code="const x = 1;" language="ts" />, 40, 3);
    t.ok(strip(frame[1]!).includes('const x = 1;'), 'code renders without line numbers');
  });

  it('renders plain text for an unrecognized language', (t) => {
    const frame = lines(<Code code={'hello world'} language="made-up" />, 40, 3);
    t.ok(
      strip(frame[1]!).includes('hello world'),
      'unrecognized language still renders the code as text',
    );
  });

  it('renders inline code inline with the surrounding text', (t) => {
    const frame = lines(
      <Text>
        run <InlineCode>cargo build</InlineCode>
      </Text>,
      30,
      1,
    );
    t.equal(strip(frame[0]!), 'run cargo build', 'inline code text renders inline');
  });

  it('applies dim + inverse styling to InlineCode composed as a row sibling', (t) => {
    const frame = lines(
      <HStack gap={0}>
        <Text>run </Text>
        <InlineCode>cargo build</InlineCode>
      </HStack>,
      30,
      1,
    );
    t.equal(strip(frame[0]!), 'run cargo build', 'text reads the same end to end');
    t.ok(
      frame[0]!.includes('\x1b[2;7mcargo build'),
      'the code span keeps its dim + inverse styling',
    );
  });
});

describe('fino:ui/components typography — html', () => {
  it('renders real heading elements at every level', (t) => {
    for (let level = 1; level <= 6; level++) {
      const html = renderToHtml(toHtml(<Heading level={level as 1}>Title</Heading>));
      t.ok(html.startsWith(`<h${level}`), `level ${level} becomes <h${level}>`);
      t.ok(html.includes('Title'), 'text content renders');
    }
  });

  it('renders strong and em for bold and italic', (t) => {
    const html = renderToHtml(
      toHtml(
        <Text>
          <Bold>bold</Bold> <Italic>italic</Italic>
        </Text>,
      ),
    );
    t.ok(html.includes('<strong'), 'bold becomes <strong>');
    t.ok(html.includes('bold</strong>'), 'bold text renders inside');
    t.ok(html.includes('<em'), 'italic becomes <em>');
    t.ok(html.includes('italic</em>'), 'italic text renders inside');
  });

  it('renders a real anchor for an href-only link', (t) => {
    const html = renderToHtml(toHtml(<Link href="https://fino.dev">docs</Link>));
    t.equal(
      html,
      '<a class="ui-link" href="https://fino.dev">docs</a>',
      'plain navigational anchor',
    );
  });

  it('accepts every allowed href scheme and relative form', (t) => {
    const allowed = [
      'https://example.com',
      'http://example.com',
      'mailto:a@b.c',
      'tel:+15551234567',
      '/relative',
      './relative',
      '../relative',
      '#anchor',
      '?query=1',
    ];
    for (const href of allowed) {
      const html = renderToHtml(toHtml(<Link href={href}>go</Link>));
      t.ok(html.includes(`href="${href}"`), `${href} keeps its href attribute`);
    }
  });

  it('drops a javascript: href instead of emitting a live anchor (XSS)', (t) => {
    const html = renderToHtml(toHtml(<Link href="javascript:alert(1)">click me</Link>));
    t.ok(!html.includes('href='), 'no href attribute at all');
    t.ok(!html.includes('javascript:'), 'the dangerous scheme never reaches markup');
    t.ok(html.includes('click me'), 'the link text still renders');
    t.equal(html, '<span class="ui-link">click me</span>', 'falls back to an inert styled span');
  });

  it('strips control characters before the scheme check, closing the tab-bypass hole', (t) => {
    const html = renderToHtml(toHtml(<Link href={'java\tscript:alert(1)'}>click me</Link>));
    t.ok(!html.includes('href='), 'the control-character bypass is still rejected');
    t.ok(!html.includes('javascript:'), 'stripping the tab does not let the scheme sneak through');
  });

  it('rejects other dangerous or unrecognized schemes', (t) => {
    for (const href of ['data:text/html,<script>1</script>', 'vbscript:msgbox(1)', 'ftp://x/y']) {
      const html = renderToHtml(toHtml(<Link href={href}>go</Link>));
      t.ok(!html.includes('href='), `${href} is rejected`);
    }
  });

  it('rejects a non-string href without throwing', (t) => {
    const html = renderToHtml(toHtml(<Link href={42 as unknown as string}>go</Link>));
    t.ok(!html.includes('href='), 'non-string href is rejected, not coerced');
  });

  it('renders a link-styled button for a handler-only link and routes clicks', (t) => {
    const actions = new Map<string, (value?: string) => void>();
    let clicks = 0;
    const html = renderToHtml(toHtml(<Link onActivate={() => clicks++}>run</Link>, { actions }));
    t.ok(html.includes('name="do"'), 'handler link rides an action form');
    t.ok(!html.includes('<a '), 'no anchor when there is no href');
    const doId = /name="do" value="(a\d+)"/.exec(html)![1]!;
    actions.get(doId)!();
    t.equal(clicks, 1, 'invoking the action fires onActivate');
  });

  it('keeps the href as the anchor target when both href and onActivate are given', (t) => {
    const actions = new Map<string, (value?: string) => void>();
    let clicks = 0;
    const html = renderToHtml(
      toHtml(
        <Link href="https://fino.dev" onActivate={() => clicks++}>
          docs
        </Link>,
        { actions },
      ),
    );
    t.ok(html.includes('href="https://fino.dev"'), 'href rides on the anchor');
    t.ok(html.includes('name="do"'), 'the handler still wires an action form');
    const doId = /name="do" value="(a\d+)"/.exec(html)![1]!;
    actions.get(doId)!();
    t.equal(clicks, 1, 'the handler intercepts instead of navigating');
  });

  it('drops a handler-only link to an inert-looking button without a collector', (t) => {
    const html = renderToHtml(toHtml(<Link onActivate={() => {}}>run</Link>));
    t.ok(html.includes('<button'), 'static markup still renders a button shape');
    t.ok(!html.includes('<form'), 'no action wiring without a collector');
  });

  it('renders a blockquote element with a left border class', (t) => {
    const html = renderToHtml(
      toHtml(
        <Blockquote>
          <Text>quoted</Text>
        </Blockquote>,
      ),
    );
    t.ok(html.startsWith('<blockquote class="ui-blockquote"'), 'real blockquote element');
    t.ok(html.includes('quoted'), 'content renders inside');
  });

  it('renders real ul/ol markup for lists', (t) => {
    const bullets = renderToHtml(toHtml(<List items={['a', 'b']} />));
    t.ok(bullets.startsWith('<ul class="ui-list"'), 'unordered list becomes a <ul>');
    t.ok(
      bullets.includes('<li>a</li>') && bullets.includes('<li>b</li>'),
      'items become <li> elements',
    );
    const numbers = renderToHtml(toHtml(<List ordered items={['a', 'b']} />));
    t.ok(numbers.startsWith('<ol class="ui-list"'), 'ordered list becomes an <ol>');
  });

  it('lowers nested content within list items', (t) => {
    const html = renderToHtml(
      toHtml(
        <List
          items={[
            <Text>
              plain <Bold>bold</Bold>
            </Text>,
          ]}
        />,
      ),
    );
    t.ok(html.includes('<strong'), 'nested semantic content inside a list item still lowers');
  });

  it('renders highlighted <pre><code> with per-token spans for a known language', (t) => {
    const html = renderToHtml(toHtml(<Code code="const x = 1;" language="ts" />));
    t.ok(html.includes('<pre><code'), 'pre/code wrapper');
    t.ok(html.includes('class="tok-keyword"'), 'keyword token gets a highlighting class');
    t.ok(html.includes('>const<'), 'keyword text renders');
  });

  it('renders a code block plainly for an unrecognized language', (t) => {
    const html = renderToHtml(toHtml(<Code code="hello world" language="made-up" />));
    t.ok(html.includes('hello world'), 'plain text renders');
    t.ok(!html.includes('tok-'), 'no token classes for an unknown language');
  });

  it('renders line numbers only when requested', (t) => {
    const html = renderToHtml(toHtml(<Code code={'a();\nb();'} language="js" showLineNumbers />));
    t.ok(html.includes('class="ui-code-num">1<'), 'first line number renders');
    t.ok(html.includes('class="ui-code-num">2<'), 'second line number renders');
    const noNumbers = renderToHtml(toHtml(<Code code={'a();\nb();'} language="js" />));
    t.ok(!noNumbers.includes('ui-code-num'), 'no gutter without showLineNumbers');
  });

  it('renders a <code> element for inline code', (t) => {
    const html = renderToHtml(toHtml(<InlineCode>npm i</InlineCode>));
    t.equal(html, '<code class="ui-inline-code">npm i</code>', 'inline code element');
  });
});

describe('fino:ui/components Code filename + copy — terminal', () => {
  it('renders no header bar without filename or copyable', (t) => {
    const frame = lines(<Code code="const x = 1;" language="ts" />, 40, 3);
    t.ok(strip(frame[0]!).startsWith('┌'), 'the border is the first row — no header bar');
  });

  it('renders a dim filename header row above a rule, above the code', (t) => {
    const frame = lines(<Code code="const x = 1;" language="ts" filename="a.ts" />, 40, 5);
    t.ok(strip(frame[1]!).includes('a.ts'), 'filename renders in its own row');
    t.ok(strip(frame[2]!).includes('──────'), 'a rule separates the header from the code');
    t.ok(strip(frame[3]!).includes('const x = 1;'), 'code follows beneath the rule');
  });

  it('shows the copy affordance in the header even without a filename', (t) => {
    const frame = lines(<Code code="const x = 1;" language="ts" copyable />, 40, 4);
    t.ok(
      frame.some((row) => strip(row).includes('copy')),
      'the copy affordance still gets a header row',
    );
  });

  it('calls onCopy with the source when the copy affordance is clicked', (t) => {
    const app = live(40, 5);
    const copied: string[] = [];
    app.render(
      <Code
        code="const x = 1;"
        language="ts"
        filename="a.ts"
        copyable
        onCopy={(code) => copied.push(code)}
      />,
    );
    const row = app.text().findIndex((line) => strip(line).includes('copy'));
    t.ok(row >= 0, 'the copy affordance is painted');
    const col = strip(app.text()[row]!).indexOf('copy');
    click(app, col, row);
    t.deepEqual(copied, ['const x = 1;'], 'onCopy fires with the raw source');
  });
});

describe('fino:ui/components Code filename + copy — html', () => {
  it('renders no figcaption without filename or copyable', (t) => {
    const html = renderToHtml(toHtml(<Code code="const x = 1;" language="ts" />));
    t.ok(html.startsWith('<figure class="ui-code"'), 'still a figure, for a stable base element');
    t.ok(!html.includes('<figcaption'), 'no header bar when neither prop is set');
  });

  it('renders a figcaption bar with the filename above the code', (t) => {
    const html = renderToHtml(toHtml(<Code code="const x = 1;" language="ts" filename="a.ts" />));
    t.ok(html.includes('<figcaption class="ui-code-bar">'), 'figcaption header bar');
    t.ok(html.includes('class="ui-code-filename">a.ts<'), 'filename renders in the bar');
    t.ok(html.indexOf('figcaption') < html.indexOf('<pre>'), 'the bar sits above the code');
  });

  it('renders an always-in-the-tab-order copy button with an aria-label', (t) => {
    const html = renderToHtml(
      toHtml(<Code code="const x = 1;" language="ts" filename="a.ts" copyable />),
    );
    t.ok(html.includes('data-fi-copy="1"'), 'the button carries the client copy marker');
    t.ok(html.includes('aria-label="Copy code"'), 'accessible name for the icon-only button');
    t.ok(
      !html.includes('display:none') && !html.includes('display: none'),
      'never display:none — stays reachable by keyboard',
    );
  });

  it('renders a home for the copy button even without a filename', (t) => {
    const html = renderToHtml(toHtml(<Code code="const x = 1;" language="ts" copyable />));
    t.ok(html.includes('<figcaption class="ui-code-bar">'), 'bar still renders');
    t.ok(html.includes('class="ui-code-filename"></span>'), 'empty filename label');
    t.ok(html.includes('data-fi-copy="1"'), 'copy button renders right-aligned in the bar');
  });

  it('reveals the copy button on hover/focus via CSS, not markup toggling', (t) => {
    t.ok(PAGE_CSS.includes('.ui-copy {') && PAGE_CSS.includes('opacity: 0;'), 'hidden by default');
    t.ok(
      PAGE_CSS.includes('.ui-code:hover .ui-copy') &&
        PAGE_CSS.includes('.ui-code:focus-within .ui-copy'),
      'revealed on hover or focus-within, so keyboard users see it too',
    );
  });
});
