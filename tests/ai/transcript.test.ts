import { describe, it } from 'fino:test/test';
import {
  SessionTranscript,
  TranscriptWriter,
  contentText,
  foldEventsToTranscript,
  previewText,
} from 'fino:ai/transcript';
import { DiskFileSystem } from 'fino:file';
import type { AgentEvent } from 'fino:ai/runtime';

let counter = 0;
function tempDir(): string {
  return `/tmp/fino-transcript-test-${Date.now().toString(36)}-${counter++}`;
}

async function readLines(path: string): Promise<Record<string, unknown>[]> {
  const fs = new DiskFileSystem();
  const text = new TextDecoder().decode(await fs.readFile(path));
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function textDelta(text: string): AgentEvent {
  return { type: 'model_event', event: { type: 'text_delta', index: 0, text } };
}

describe('fino:ai/transcript — writer', () => {
  it('appends ordered JSONL lines and creates missing directories', async (t) => {
    const dir = tempDir();
    const writer = new TranscriptWriter(`${dir}/deep/nested/log.jsonl`);
    writer.append({ type: 'user', text: 'one' });
    writer.append({ type: 'assistant', text: 'two' });
    await writer.close();
    const lines = await readLines(`${dir}/deep/nested/log.jsonl`);
    t.equal(lines.length, 2, 'two lines');
    t.equal(lines[0]!.type, 'user', 'first line type');
    t.equal(lines[1]!.text, 'two', 'second line text');
    t.ok(typeof lines[0]!.ts === 'number', 'timestamps added');
  });

  it('keeps an explicit timestamp and drops appends after close', async (t) => {
    const dir = tempDir();
    const path = `${dir}/log.jsonl`;
    const writer = new TranscriptWriter(path);
    writer.append({ ts: 42, type: 'user', text: 'stamped' });
    await writer.close();
    writer.append({ type: 'user', text: 'after close' });
    await writer.close();
    const lines = await readLines(path);
    t.equal(lines.length, 1, 'only the pre-close line landed');
    t.equal(lines[0]!.ts, 42, 'caller timestamp wins over the default');
  });

  it('appends to an existing file rather than truncating it', async (t) => {
    const dir = tempDir();
    const path = `${dir}/log.jsonl`;
    const first = new TranscriptWriter(path);
    first.append({ type: 'user', text: 'session one' });
    await first.close();
    const second = new TranscriptWriter(path);
    second.append({ type: 'user', text: 'session two' });
    await second.close();
    const lines = await readLines(path);
    t.deepEqual(
      lines.map((line) => line.text),
      ['session one', 'session two'],
      'a reopened transcript continues the file',
    );
  });
});

describe('fino:ai/transcript — session file set', () => {
  it('writes per-child transcripts for sub-agent conversations', async (t) => {
    const dir = tempDir();
    const transcript = new SessionTranscript(`${dir}/transcripts`, 'thread-1');
    transcript.parent().append({ type: 'user', text: 'root' });
    transcript.child('sa_1').append({ type: 'user', text: 'child task' });
    await transcript.close();
    const parent = await readLines(`${dir}/transcripts/thread-1.jsonl`);
    const child = await readLines(`${dir}/transcripts/thread-1/sa_1.jsonl`);
    t.equal(parent[0]!.text, 'root', 'parent file written');
    t.equal(child[0]!.text, 'child task', 'child file written');
  });

  it('hands back the same writer per id and touches nothing until an append', async (t) => {
    const dir = tempDir();
    const transcript = new SessionTranscript(dir, 'thread-1');
    t.equal(transcript.parent(), transcript.parent(), 'one parent writer');
    t.equal(transcript.child('sa_1'), transcript.child('sa_1'), 'one writer per child');
    t.ok(transcript.child('sa_1') !== transcript.child('sa_2'), 'children are distinct');
    await transcript.close();
    const fs = new DiskFileSystem();
    let created = true;
    try {
      await fs.lstat(dir);
    } catch (_) {
      created = false;
    }
    t.equal(created, false, 'no directory created without an append');
  });
});

describe('fino:ai/transcript — event folding', () => {
  it('folds text deltas, tool activity, and step boundaries into lines', async (t) => {
    const dir = tempDir();
    const path = `${dir}/fold.jsonl`;
    const writer = new TranscriptWriter(path);
    const fold = foldEventsToTranscript(writer);
    fold.onEvent(textDelta('thinking '));
    fold.onEvent(textDelta('about it'));
    fold.onEvent({ type: 'tool_start', stepIndex: 0, id: 'c1', name: 'read_file', args: { p: 1 } });
    fold.onEvent({
      type: 'tool_result',
      stepIndex: 0,
      id: 'c1',
      name: 'read_file',
      content: [{ type: 'text', text: 'file body' }],
    });
    fold.onEvent(textDelta('done'));
    fold.flush();
    await writer.close();
    const lines = await readLines(path);
    t.deepEqual(
      lines.map((line) => line.type),
      ['assistant', 'tool_start', 'tool_result', 'assistant'],
      'deltas flush ahead of the tool call they precede',
    );
    t.equal(lines[0]!.text, 'thinking about it', 'deltas coalesce into one line');
    t.equal(lines[1]!.args, '{"p":1}', 'tool arguments recorded as JSON text');
    t.equal(lines[2]!.output, 'file body', 'tool output flattened to text');
    t.equal(lines[3]!.text, 'done', 'trailing text flushed at turn end');
  });

  it('flushes on step end and suspend, and marks failed tool results', async (t) => {
    const dir = tempDir();
    const path = `${dir}/fold.jsonl`;
    const writer = new TranscriptWriter(path);
    const fold = foldEventsToTranscript(writer);
    fold.onEvent(textDelta('before the step ends'));
    fold.onEvent({
      type: 'step_end',
      stepIndex: 0,
      stopReason: 'end_turn',
      model: 'm',
      provider: 'p',
    });
    fold.onEvent(textDelta('before the suspend'));
    fold.onEvent({ type: 'suspend', stepIndex: 1 });
    fold.onEvent({
      type: 'tool_result',
      stepIndex: 1,
      id: 'c2',
      name: 'shell',
      isError: true,
      content: 'command failed',
    });
    fold.flush();
    await writer.close();
    const lines = await readLines(path);
    t.deepEqual(
      lines.map((line) => line.type),
      ['assistant', 'assistant', 'tool_result'],
      'both boundaries flush the buffered text',
    );
    t.equal(lines[2]!.isError, true, 'failed results carry the error flag');
    t.equal(lines[2]!.output, 'command failed', 'string content passes through');
  });

  it('writes nothing for whitespace-only text and ignores unrelated events', async (t) => {
    const dir = tempDir();
    const path = `${dir}/fold.jsonl`;
    const writer = new TranscriptWriter(path);
    const fold = foldEventsToTranscript(writer);
    fold.onEvent(textDelta('   \n'));
    fold.onEvent({ type: 'step_start', stepIndex: 0, model: 'm', provider: 'p' });
    fold.flush();
    fold.onEvent(textDelta('real text'));
    fold.flush();
    await writer.close();
    const lines = await readLines(path);
    t.equal(lines.length, 1, 'only the meaningful line was written');
    t.equal(lines[0]!.text, 'real text', 'buffer reset after an empty flush');
  });
});

describe('fino:ai/transcript — text helpers', () => {
  it('flattens content parts and marks non-text ones', async (t) => {
    t.equal(contentText('plain'), 'plain', 'strings pass through');
    t.equal(
      contentText([{ type: 'text', text: 'ok' }, { type: 'image' }, { type: 'text' }]),
      'ok\n[image]\n',
      'non-text parts collapse to a marker and missing text is empty',
    );
  });

  it('truncates previews and annotates how much was dropped', async (t) => {
    t.equal(previewText('abcdef', 6), 'abcdef', 'text at the limit is untouched');
    t.equal(previewText('abcdef', 3), 'abc… [truncated 3 chars]', 'longer text is cut');
    t.equal(
      previewText('x'.repeat(4_001)),
      'x'.repeat(4_000) + '… [truncated 1 chars]',
      'the default limit is 4000 characters',
    );
  });
});
