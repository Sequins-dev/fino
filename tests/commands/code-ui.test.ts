import { describe, it } from 'fino:test/test';
import { stripAnsi } from 'fino:tty/tui';
import {
  renderUserBlock,
  renderAssistantBlock,
  assistantBlockPrefix,
  renderToolBlock,
  renderNoticeBlock,
  renderTurnBlock,
  renderApprovalDecision,
  renderSessionHeader,
  renderEntry,
  turnMarkerText,
  formatDuration,
  type TranscriptEntry,
} from 'internal:commands/code/ui/blocks';
import { entriesFromHistory, seedEntries, inputHistoryFromMessages } from 'internal:commands/code/ui/history';
import { StreamTail } from 'internal:commands/code/ui/stream';
import { renderActivityLive, renderRunningTool } from 'internal:commands/code/ui/activity';
import { renderApprovalBand } from 'internal:commands/code/ui/approval';
import type { ModelMessage } from 'fino:ai/model';
import type { CodeTurnRecord } from 'fino:commands/code/engine';

const WIDTHS = [40, 72];

function turn(status: 'done' | 'error', durationMs: number, messages = 2): CodeTurnRecord {
  return { at: 1000, durationMs, status, messages } as CodeTurnRecord;
}

describe('internal:commands/code/ui blocks', () => {
  it('renders user blocks with the gutter and hanging indent', (t) => {
    for (const width of WIDTHS) {
      const lines = renderUserBlock('please look at the thing and tell me what it does', width);
      t.ok(stripAnsi(lines[0]!).startsWith('❯ '), `gutter at width ${width}`);
      for (const line of lines.slice(1)) {
        t.ok(stripAnsi(line).startsWith('  '), 'continuation indented');
      }
      for (const line of lines) {
        t.ok(stripAnsi(line).length <= width, `within width ${width}`);
      }
    }
  });

  it('opens assistant blocks with a rule and blank row', (t) => {
    const lines = renderAssistantBlock('hello **world**', 40);
    t.equal(stripAnsi(lines[0]!), '─'.repeat(39), 'rule stops a column short of the width');
    t.equal(lines[1], '', 'blank after the rule');
    t.ok(lines.slice(2).some((line) => stripAnsi(line).includes('hello')), 'markdown body');
    t.deepEqual(
      lines.slice(0, 2),
      assistantBlockPrefix(40),
      'prefix helper matches the block opening',
    );
  });

  it('renders committed tool blocks with state mark and capped preview', (t) => {
    const ok = renderToolBlock(
      { name: 'read_file', args: { path: 'a.ts' }, state: 'ok', output: 'line1\nline2\nline3\nline4' },
      60,
    );
    t.ok(stripAnsi(ok[0]!).startsWith('● read_file'), 'signature line');
    t.ok(ok.length <= 3, 'preview capped at two lines');
    const err = renderToolBlock({ name: 'bash', state: 'error' }, 60);
    t.ok(err[0]!.includes('\x1b[31m'), 'error mark is red');
    t.equal(err.length, 1, 'no preview without output');
  });

  it('renders turn markers and approval decisions dim', (t) => {
    t.equal(stripAnsi(renderTurnBlock(turn('done', 12_000), 40)[0]!), '✔ 12s', 'done marker');
    t.equal(turnMarkerText(turn('error', 61_000)), '✗ 1m 1s', 'error marker with minutes');
    t.equal(formatDuration(500), '1s', 'sub-second rounds');
    const decision = renderApprovalDecision(
      { sourceLabel: 'main / parent', toolName: 'bash', approved: false },
      60,
    );
    t.equal(stripAnsi(decision[0]!), '✗ rejected bash — main / parent', 'decision record');
  });

  it('renders session headers for each kind', (t) => {
    const session = renderSessionHeader(
      { title: 'my session', kind: 'session', subtitle: 'claude-test · BUILD' },
      40,
    );
    t.equal(session[0], '', 'leading blank');
    t.equal(stripAnsi(session[1]!), '━'.repeat(39), 'heavy rule stops a column short');
    t.equal(stripAnsi(session[2]!), '» my session', 'titled');
    t.equal(stripAnsi(session[3]!), 'claude-test · BUILD', 'subtitle');
    t.equal(session[session.length - 1], '', 'trailing blank');
    const child = renderSessionHeader(
      { title: 'explorer', kind: 'subagent', childStatus: 'done' },
      40,
    );
    t.ok(stripAnsi(child[2]!).startsWith('● explorer'), 'child glyph replaces the chevron');
  });

  it('dispatches renderEntry per kind', (t) => {
    const entries: TranscriptEntry[] = [
      { kind: 'user', text: 'hi' },
      { kind: 'assistant', text: 'yo' },
      { kind: 'tool', text: 'bash', toolState: 'error', argsValue: { cmd: 'ls' } },
      { kind: 'notice', text: 'note' },
      { kind: 'turn', text: '✔ 3s' },
    ];
    for (const entry of entries) {
      const lines = renderEntry(entry, 40);
      t.ok(lines.length > 0, `${entry.kind} renders`);
      for (const line of lines) t.ok(stripAnsi(line).length <= 40, `${entry.kind} within width`);
    }
  });
});

describe('internal:commands/code/ui history', () => {
  const messages: ModelMessage[] = [
    { role: 'user', content: 'first question' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'let me check' },
        { type: 'tool_use', id: 't1', name: 'read_file', args: { path: 'x' } },
      ],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', toolCallId: 't1', content: 'file body', isError: false }],
    },
    { role: 'assistant', content: 'all done' },
    { role: 'user', content: '[subagent settlement] child done' },
  ] as ModelMessage[];

  it('rebuilds entries with tool results folded in and markers placed', (t) => {
    const entries = entriesFromHistory(messages, [turn('done', 5000, 4)]);
    const kinds = entries.map((entry) => entry.kind);
    t.deepEqual(kinds, ['user', 'assistant', 'tool', 'assistant', 'turn', 'notice'], 'entry order');
    const tool = entries.find((entry) => entry.kind === 'tool')!;
    t.equal(tool.outputText, 'file body', 'tool result folded onto the call');
    t.equal(entries[4]!.text, '✔ 5s', 'turn marker between the right messages');
  });

  it('keeps pinned entries across a reseed', (t) => {
    const current: TranscriptEntry[] = [
      { kind: 'notice', text: 'banner', pin: 'top' },
      { kind: 'user', text: 'stale' },
      { kind: 'notice', text: 'status', pin: 'bottom' },
    ];
    const seeded = seedEntries(current, messages);
    t.equal(seeded[0]!.text, 'banner', 'top pin first');
    t.equal(seeded[seeded.length - 1]!.text, 'status', 'bottom pin last');
    t.ok(!seeded.some((entry) => entry.text === 'stale'), 'unpinned entries replaced');
  });

  it('extracts typed input history without synthetics', (t) => {
    t.deepEqual(inputHistoryFromMessages(messages), ['first question'], 'settlements excluded');
  });
});

describe('internal:commands/code/ui stream', () => {
  it('splits settled and tail, committing each line exactly once', (t) => {
    const tail = new StreamTail(40);
    const committed: string[] = [];
    tail.push('# Title\n\nfirst paragraph');
    committed.push(...tail.takeSettled());
    tail.push(' still going\n\nsecond paragraph here\n\nthird');
    committed.push(...tail.takeSettled());
    t.ok(tail.tailLines(8).length > 0, 'unsettled tail visible');
    committed.push(...tail.finish());
    const whole = new StreamTail(40);
    whole.push('# Title\n\nfirst paragraph still going\n\nsecond paragraph here\n\nthird');
    const reference = whole.finish();
    t.deepEqual(committed, reference, 'streamed commits equal one-shot render');
    t.deepEqual(tail.finish(), [], 'finish is terminal');
  });

  it('caps the footer tail but not the commit', (t) => {
    const tail = new StreamTail(40);
    tail.push('```ts\n' + Array.from({ length: 12 }, (_, i) => `const x${i} = ${i};`).join('\n'));
    tail.takeSettled();
    t.equal(tail.tailLines(4).length, 4, 'tail capped to last N lines');
    const flushed = tail.finish();
    t.ok(flushed.length > 10, 'full block still commits wholesale');
  });

  it('streams a long block through the footer without losing a line', (t) => {
    // A block only settles when the next one starts, so anything past the
    // footer's capacity has to be committed as it goes or it would scroll
    // out of the dynamic area unseen.
    const code = Array.from({ length: 30 }, (_, i) => `const value${i} = ${i};`);
    const source = 'Intro.\n\n```ts\n' + code.join('\n') + '\n```\n\nDone.';
    const capacity = 5;
    const tail = new StreamTail(60);
    const committed: string[] = [];
    for (let i = 0; i < source.length; i += 9) {
      tail.push(source.slice(i, i + 9));
      committed.push(...tail.takeSettled());
      committed.push(...tail.takeOverflow(capacity));
      const shown = tail.tailLines(capacity);
      t.ok(shown.length <= capacity, 'tail stays within capacity');
      const visible = [...committed, ...shown].join('\n');
      const seen = code.map((_, n) => visible.includes(`value${n} =`));
      const highest = seen.lastIndexOf(true);
      for (let n = 0; n <= highest; n++) {
        if (!seen[n]) t.ok(false, `value${n} vanished between commit and footer`);
      }
    }
    committed.push(...tail.finish());
    const all = committed.join('\n');
    for (let n = 0; n < code.length; n++) {
      const hits = all.split(`value${n} =`).length - 1;
      t.equal(hits, 1, `value${n} committed exactly once`);
    }
  });

  it('holds a table whole rather than committing rows it may rewrite', (t) => {
    // Column widths change as rows arrive, so an early commit would leave
    // mis-aligned rows frozen in scrollback.
    const tail = new StreamTail(40);
    tail.push('Intro.\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n| much longer | x |');
    tail.takeSettled();
    t.deepEqual(tail.takeOverflow(1), [], 'no partial table commit');
  });
});

describe('internal:commands/code/ui activity', () => {
  it('renders the live indicator parts in order', (t) => {
    const line = renderActivityLive({
      spinnerFrame: '⠋',
      planMode: true,
      activity: 'read_file',
      startedAt: 0,
      now: 12_000,
      subagentsActive: 2,
      queued: 1,
      width: 100,
    });
    t.equal(
      stripAnsi(line),
      '⠋ Planning · read_file · 12s · 2 sub-agents · 1 queued · Ctrl+C interrupts',
      'joined parts',
    );
  });

  it('renders running tool detail with trailing output lines', (t) => {
    const lines = renderRunningTool({
      name: 'bash',
      args: { cmd: 'ls' },
      output: Array.from({ length: 10 }, (_, i) => `out ${i}`).join('\n'),
      width: 60,
    });
    t.ok(stripAnsi(lines[0]!).startsWith('● bash'), 'signature head');
    t.ok(lines.length <= 7, 'detail capped');
    t.ok(stripAnsi(lines[lines.length - 1]!).includes('out 9'), 'shows the newest output');
  });
});

describe('internal:commands/code/ui approval', () => {
  it('renders the approval band boxed with source, tool, and keys', (t) => {
    const lines = renderApprovalBand(
      {
        sourceLabel: 'my session / parent',
        request: {
          type: 'tool_approval',
          toolCallId: 'c1',
          toolName: 'bash',
          args: { cmd: 'rm -rf /tmp/x' },
          risk: 'destructive',
        } as never,
      },
      3,
      80,
    );
    const text = lines.map((line) => stripAnsi(line)).join('\n');
    t.ok(text.includes('approval required'), 'title');
    t.ok(text.includes('(1 of 3)'), 'queue position');
    t.ok(text.includes('my session / parent'), 'source label');
    t.ok(text.includes('bash') && text.includes('destructive'), 'tool and risk');
    t.ok(text.includes('y approve · n reject'), 'answer keys');
    t.ok(lines[0]!.includes('┌') && lines[lines.length - 1]!.includes('└'), 'boxed');
  });
});
