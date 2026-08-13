import { describe, it } from 'fino:test/test';
import {
  MarkdownTerminalStream,
  highlightCodeTerminal,
  renderMarkdownInlineTerminal,
  renderMarkdownTerminal,
} from 'fino:format/markdown';

const ESC = '\x1b';

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('fino:format/markdown — renderMarkdownTerminal', () => {
  it('renders headings, emphasis, and inline code with ANSI styling', (t) => {
    const out = renderMarkdownTerminal('# Title\n\nUse `fino test` for **speed**.', { width: 60 });
    t.ok(out.includes(`${ESC}[1;36m`), 'heading opens bold cyan');
    t.ok(stripAnsi(out).includes('# Title'), 'heading keeps its marker');
    t.ok(out.includes(`${ESC}[36mfino test${ESC}[0m`), 'inline code is cyan');
    t.ok(out.includes(`${ESC}[1mspeed${ESC}[0m`), 'strong text is bold');
  });

  it('renders plain wrapped text with color disabled', (t) => {
    const out = renderMarkdownTerminal('Use `fino test` for **speed**.', {
      width: 60,
      color: false,
    });
    t.equal(out, 'Use `fino test` for speed.', 'no escapes, backticks kept, markers dropped');
  });

  it('word-wraps paragraphs at the configured width', (t) => {
    const out = renderMarkdownTerminal(
      'one two three four five six seven eight nine ten eleven twelve',
      { width: 20, color: false },
    );
    const lines = out.split('\n');
    t.ok(lines.length > 2, 'wrapped into multiple lines');
    for (const line of lines) {
      t.ok(line.length <= 20, `line fits width: ${JSON.stringify(line)}`);
    }
  });

  it('keeps styling across wrapped lines', (t) => {
    const out = renderMarkdownTerminal(
      '**bold text that definitely wraps across the narrow width limit**',
      { width: 16 },
    );
    const lines = out.split('\n');
    t.ok(lines.length > 1, 'wrapped');
    for (const line of lines.slice(1)) {
      t.ok(line.startsWith(`${ESC}[1m`), 'continuation line reopens bold');
    }
    for (const line of lines) {
      t.ok(line.endsWith(`${ESC}[0m`), 'every styled line resets at the end');
    }
  });

  it('renders lists with task markers', (t) => {
    const out = renderMarkdownTerminal('- [x] shipped\n- [ ] pending\n- plain', {
      width: 40,
      color: false,
    });
    const lines = out.split('\n');
    t.equal(lines[0], '• [x] shipped', 'checked task');
    t.equal(lines[1], '• [ ] pending', 'unchecked task');
    t.equal(lines[2], '• plain', 'ordinary item');
  });

  it('renders ordered lists with aligned markers', (t) => {
    const out = renderMarkdownTerminal('1. first\n2. second', { width: 40, color: false });
    t.deepEqual(out.split('\n'), ['1. first', '2. second'], 'numbered markers');
  });

  it('prefixes blockquotes and wraps their content', (t) => {
    const out = renderMarkdownTerminal('> quoted words that wrap somewhere', {
      width: 20,
      color: false,
    });
    for (const line of out.split('\n')) {
      t.ok(line.startsWith('│ '), `quote bar on: ${JSON.stringify(line)}`);
    }
  });

  it('renders tables with alignment and a header rule', (t) => {
    const out = renderMarkdownTerminal('| Name | N |\n|------|--:|\n| a | 1 |\n| bb | 20 |', {
      width: 40,
      color: false,
    });
    const lines = out.split('\n');
    t.equal(lines[0], 'Name   N', 'header cell right-aligned too');
    t.equal(lines[1], '────  ──', 'rule sized to columns');
    t.equal(lines[2], 'a      1', 'right-aligned numeric cell');
    t.equal(lines[3], 'bb    20', 'right-aligned wide cell');
  });

  it('indents code blocks and highlights TypeScript', (t) => {
    const out = renderMarkdownTerminal('```ts\nconst x = 1;\n```', { width: 60 });
    t.ok(out.startsWith('    '), 'code block is indented');
    t.ok(out.includes(`${ESC}[35mconst${ESC}[0m`), 'keyword colored');
    t.ok(out.includes(`${ESC}[33m1${ESC}[0m`), 'number colored');
  });

  it('renders links as label plus dim URL', (t) => {
    const colored = renderMarkdownTerminal('[docs](https://example.com/d)', { width: 80 });
    t.ok(stripAnsi(colored).includes('docs (https://example.com/d)'), 'label and url present');
    const plain = renderMarkdownTerminal('[docs](https://example.com/d)', {
      width: 80,
      color: false,
    });
    t.equal(plain, 'docs (https://example.com/d)', 'plain link form');
  });

  it('strips control characters from untrusted input', (t) => {
    const out = renderMarkdownTerminal('evil \x1b[31mred\x1b[0m text', { width: 40 });
    t.ok(!out.includes(`${ESC}[31m`), 'injected escape removed');
    t.ok(stripAnsi(out).includes('evil [31mred[0m text'), 'literal remainder kept');
  });

  it('accepts a custom code renderer', (t) => {
    const out = renderMarkdownTerminal('```sql\nSELECT 1;\n```', {
      width: 40,
      renderCode: (code, lang) => [`<${lang}> ${code.trim()}`],
    });
    t.equal(out, '    <sql> SELECT 1;', 'hook output used verbatim');
  });
});

describe('fino:format/markdown — renderMarkdownInlineTerminal', () => {
  it('styles spans without wrapping', (t) => {
    const out = renderMarkdownInlineTerminal('a **b** and `c`');
    t.equal(out, `a ${ESC}[1mb${ESC}[0m and ${ESC}[36mc${ESC}[0m`, 'bold and code spans styled');
  });

  it('reapplies outer styles after nested spans close', (t) => {
    const out = renderMarkdownInlineTerminal('**bold `c` bold**');
    t.equal(
      out,
      `${ESC}[1mbold ${ESC}[36mc${ESC}[0m${ESC}[1m bold${ESC}[0m`,
      'code close restores bold',
    );
  });

  it('renders plain text with color disabled', (t) => {
    const out = renderMarkdownInlineTerminal('a **b** and `c`', { color: false });
    t.equal(out, 'a b and `c`', 'markers dropped, backticks kept');
  });
});

describe('fino:format/markdown — highlightCodeTerminal', () => {
  it('returns plain lines for unsupported languages', (t) => {
    t.deepEqual(highlightCodeTerminal('SELECT 1;', 'sql'), ['SELECT 1;']);
  });

  it('returns plain lines when color is disabled', (t) => {
    t.deepEqual(highlightCodeTerminal('const x = 1;', 'ts', { color: false }), ['const x = 1;']);
  });

  it('colors comments and keywords', (t) => {
    const lines = highlightCodeTerminal('// note\nconst x = 1;', 'ts');
    t.ok(lines[0]!.includes(`${ESC}[90m// note${ESC}[0m`), 'comment dimmed');
    t.ok(lines[1]!.includes(`${ESC}[35mconst${ESC}[0m`), 'keyword colored');
  });

  it('reapplies styling on every line of multi-line tokens', (t) => {
    const lines = highlightCodeTerminal('/* a\n   b */\nconst y = 2;', 'ts');
    t.ok(lines[0]!.includes(`${ESC}[90m`), 'first comment line styled');
    t.ok(lines[1]!.startsWith(`${ESC}[90m`), 'second comment line reopens style');
  });

  it('highlights unparseable source lexically', (t) => {
    const lines = highlightCodeTerminal('export function add(a: num', 'ts');
    t.ok(lines[0]!.includes(`${ESC}[35mexport${ESC}[0m`), 'keyword colored without a parse');
    t.equal(stripAnsi(lines[0]!), 'export function add(a: num', 'source preserved exactly');
  });

  it('colors strings, comments, and numbers in half-written code', (t) => {
    const lines = highlightCodeTerminal('const s = "hi"; // note\nconst n = 42;\nif (', 'ts');
    t.ok(lines[0]!.includes(`${ESC}[32m"hi"${ESC}[0m`), 'string colored');
    t.ok(lines[0]!.includes(`${ESC}[90m// note${ESC}[0m`), 'comment dimmed');
    t.ok(lines[1]!.includes(`${ESC}[33m42${ESC}[0m`), 'number colored');
    t.equal(stripAnsi(lines[2]!), 'if (', 'unterminated line kept verbatim');
  });
});

describe('fino:format/markdown — MarkdownTerminalStream', () => {
  const DOC = [
    '# Heading',
    '',
    'A paragraph with **bold** text.',
    '',
    '```ts',
    'export function add(a: number, b: number): number {',
    '  return a + b;',
    '}',
    '```',
    '',
    'Closing prose.',
  ].join('\n');

  it('matches a whole-text render once the text is complete', (t) => {
    const stream = new MarkdownTerminalStream({ width: 60 });
    for (let end = 1; end <= DOC.length; end++) stream.render(DOC.slice(0, end));
    t.deepEqual(
      stream.render(DOC),
      renderMarkdownTerminal(DOC, { width: 60 }).split('\n'),
      'incremental output equals a single render of the same text',
    );
  });

  it('renders every prefix the same as a whole-text render of that prefix', (t) => {
    const stream = new MarkdownTerminalStream({ width: 60 });
    for (let end = 1; end <= DOC.length; end++) {
      const prefix = DOC.slice(0, end);
      const expected = renderMarkdownTerminal(prefix, { width: 60 });
      t.deepEqual(
        stream.render(prefix),
        expected.length === 0 ? [] : expected.split('\n'),
        `prefix of ${end} chars renders identically`,
      );
    }
  });

  it('highlights a fenced block before its closing fence arrives', (t) => {
    const stream = new MarkdownTerminalStream({ width: 60 });
    const partial = '# Heading\n\n```ts\nexport function add(a: num';
    const lines = stream.render(partial);
    t.ok(
      lines.some((line) => line.includes(`${ESC}[35mexport${ESC}[0m`)),
      'open code block is syntax highlighted while streaming',
    );
    t.ok(lines[0]!.includes(`${ESC}[1;36m`), 'settled heading keeps its styling');
  });

  it('keeps a loose list together instead of splitting it at the blank line', (t) => {
    const stream = new MarkdownTerminalStream({ width: 60 });
    const list = '1. one\n\n2. two\n\nAfter.';
    t.deepEqual(
      stream.render(list),
      renderMarkdownTerminal(list, { width: 60 }).split('\n'),
      'ordered list numbering survives incremental rendering',
    );
  });
});
