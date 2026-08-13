import { describe, it } from 'fino:test/test';
import {
  formatToolArgLines,
  formatToolOutputLines,
  formatToolSignature,
  languageForTool,
} from 'fino:commands/code/toolview';

const ESC = '\x1b';

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('fino:commands/code/toolview — call signatures', () => {
  it('renders arguments as named parameters', (t) => {
    t.equal(
      formatToolSignature('read_file', { path: 'js/ai/agent.ts', offset: 10 }),
      'read_file(path: "js/ai/agent.ts", offset: 10)',
      'string and number parameters',
    );
    t.equal(
      formatToolSignature('edit_file', { path: 'a.ts', replaceAll: true }),
      'edit_file(path: "a.ts", replaceAll: true)',
      'boolean parameters render bare',
    );
    t.equal(formatToolSignature('subagent_status', {}), 'subagent_status()', 'no parameters');
    t.equal(formatToolSignature('shell', undefined), 'shell()', 'missing args object');
  });

  it('flattens and truncates long or multi-line values', (t) => {
    const signature = formatToolSignature(
      'write_file',
      { path: 'x.ts', content: 'line one\nline two\n' },
      { maxValue: 12 },
    );
    t.equal(signature, 'write_file(path: "x.ts", content: "line one li…")', 'flattened + clipped');
    t.ok(!signature.includes('\n'), 'signature stays on one line');
  });

  it('skips undefined optional parameters', (t) => {
    t.equal(
      formatToolSignature('read_file', { path: 'a.ts', offset: undefined }),
      'read_file(path: "a.ts")',
      'undefined omitted',
    );
  });
});

describe('fino:commands/code/toolview — language detection', () => {
  it('infers language from a path argument', (t) => {
    t.equal(languageForTool('read_file', { path: 'a.ts' }), 'ts');
    t.equal(languageForTool('read_file', { path: 'a.mjs' }), 'js');
    t.equal(languageForTool('read_file', { path: 'guide.md' }), 'md');
    t.equal(languageForTool('read_file', { path: 'data.json' }), 'json');
    t.equal(languageForTool('read_file', { path: 'notes.txt' }), null, 'unknown extension');
    t.equal(languageForTool('shell', { command: 'ls' }), null, 'no path argument');
  });

  it('treats docs_show output as markdown', (t) => {
    t.equal(languageForTool('docs_show', { symbol: 'agent' }), 'md');
  });
});

describe('fino:commands/code/toolview — output views', () => {
  it('keeps line numbers and highlights source for numbered reads', (t) => {
    const lines = formatToolOutputLines({
      name: 'read_file',
      args: { path: 'a.ts' },
      output: '    1\t// note\n    2\tconst x = 1;',
      width: 60,
    });
    t.equal(lines.length, 2, 'one rendered line per source line');
    t.ok(lines[0]!.includes(`${ESC}[2m    1${ESC}[0m`), 'line number dimmed');
    t.ok(lines[0]!.includes(`${ESC}[90m// note${ESC}[0m`), 'comment highlighted');
    t.ok(lines[1]!.includes(`${ESC}[35mconst${ESC}[0m`), 'keyword highlighted');
  });

  it('renders markdown reads as prose without line numbers', (t) => {
    const lines = formatToolOutputLines({
      name: 'read_file',
      args: { path: 'guide.md' },
      output: '    1\t# Title\n    2\t\n    3\tSome **bold** text.',
      width: 60,
    });
    const text = lines.map(stripAnsi).join('\n');
    t.ok(text.includes('# Title'), 'heading kept');
    t.ok(!text.includes('    1'), 'line numbers dropped for rendered markdown');
    t.ok(
      lines.some((line) => line.includes(`${ESC}[1mbold${ESC}[0m`)),
      'strong text styled',
    );
  });

  it('pretty-prints JSON output', (t) => {
    const lines = formatToolOutputLines({
      name: 'subagent_spawn',
      args: { task: 'x' },
      output: '{"id":"sa_1","status":"working"}',
      width: 60,
    });
    t.deepEqual(lines, ['{', '  "id": "sa_1",', '  "status": "working"', '}'], 'expanded JSON');
  });

  it('falls back to wrapped plain text', (t) => {
    const lines = formatToolOutputLines({
      name: 'shell',
      args: { command: 'ls' },
      output: 'exit code: 0\nstdout:\nREADME.md',
      width: 60,
    });
    t.deepEqual(lines, ['exit code: 0', 'stdout:', 'README.md'], 'plain output preserved');
  });

  it('does not treat non-numbered output as a file read', (t) => {
    const lines = formatToolOutputLines({
      name: 'search_files',
      args: { pattern: 'x' },
      output: 'js/a.ts:1: const x = 1;',
      width: 60,
    });
    t.deepEqual(lines, ['js/a.ts:1: const x = 1;'], 'grep-style output untouched');
  });

  it('survives unparseable source without throwing', (t) => {
    const lines = formatToolOutputLines({
      name: 'read_file',
      args: { path: 'broken.ts' },
      output: '    1\tconst = = =',
      width: 60,
    });
    t.equal(lines.length, 1, 'still one line');
    t.ok(stripAnsi(lines[0]!).includes('const = = ='), 'source preserved verbatim');
  });
});

describe('fino:commands/code/toolview — argument views', () => {
  it('puts each parameter on its own line and formats file bodies', (t) => {
    const lines = formatToolArgLines(
      'write_file',
      { path: 'x.ts', content: 'const a = 1;\n// note\n' },
      { width: 60 },
    );
    t.equal(lines[0], 'path: "x.ts"', 'short value inline');
    t.equal(lines[1], 'content:', 'body value gets its own block');
    t.ok(lines[2]!.includes(`${ESC}[35mconst${ESC}[0m`), 'body highlighted as source');
    t.ok(lines[2]!.startsWith('  '), 'body indented');
  });

  it('wraps long non-body values instead of highlighting them', (t) => {
    const lines = formatToolArgLines(
      'docs_search',
      { query: 'a '.repeat(60).trim() },
      { width: 40 },
    );
    t.equal(lines[0], 'query:', 'long value promoted to a block');
    t.ok(lines.length > 2, 'wrapped across lines');
    for (const line of lines.slice(1)) {
      t.ok(stripAnsi(line).length <= 40, 'wrapped within width');
    }
  });

  it('returns nothing for tools without arguments', (t) => {
    t.deepEqual(formatToolArgLines('subagent_status', {}, { width: 40 }), []);
    t.deepEqual(formatToolArgLines('shell', undefined, { width: 40 }), []);
  });
});
