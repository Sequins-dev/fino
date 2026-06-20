import { describe, it } from 'fino:test/test';
import { Process, execPath } from 'fino:process';
import { isatty, stderrIsTTY, stdinIsTTY, stdoutIsTTY } from 'fino:tty';
import {
  PromptSession,
  type ConfirmPromptOptions,
  type PromptSessionOptions,
  type SelectPromptOptions,
  type TextPromptOptions,
} from 'fino:tty/prompt';

const enc = new TextEncoder();
const dec = new TextDecoder();

function joinChunks(chunks: Uint8Array[]): string {
  const out = chunks.reduce((acc: Uint8Array, chunk: Uint8Array) => {
    const merged = new Uint8Array(acc.byteLength + chunk.byteLength);
    merged.set(acc);
    merged.set(chunk, acc.byteLength);
    return merged;
  }, new Uint8Array(0));
  return dec.decode(out);
}

describe('fino:tty', () => {
  it('exposes deterministic TTY flag snapshots', (t) => {
    t.equal(typeof stdinIsTTY, 'boolean', 'stdinIsTTY is boolean');
    t.equal(typeof stdoutIsTTY, 'boolean', 'stdoutIsTTY is boolean');
    t.equal(typeof stderrIsTTY, 'boolean', 'stderrIsTTY is boolean');
    t.equal(isatty(0), stdinIsTTY, 'stdin snapshot matches isatty(0)');
    t.equal(isatty(1), stdoutIsTTY, 'stdout snapshot matches isatty(1)');
    t.equal(isatty(2), stderrIsTTY, 'stderr snapshot matches isatty(2)');
    t.equal(isatty(-1), false, 'invalid fd is not a TTY');
  });

  it('reads one line and writes stdout/stderr in a child process', async (t) => {
    const proc = new Process(execPath, ['tests/fixtures/tty-helpers.mts']);
    await proc.stdin.write(enc.encode('hello tty\r\nignored'));
    proc.stdin.close();

    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    for await (const chunk of proc.stdout) stdoutChunks.push(chunk);
    for await (const chunk of proc.stderr) stderrChunks.push(chunk);
    const result = await proc.wait();

    t.equal(result.code, 0, 'child exits successfully');
    t.equal(joinChunks(stdoutChunks), 'prompt>stdout:hello tty\n', 'readLine strips newline and ignores carriage return');
    t.equal(joinChunks(stderrChunks), 'stderr:ok\n', 'writeStderr writes text');
  });

  it('returns a partial line when stdin closes before newline', async (t) => {
    const proc = new Process(execPath, ['tests/fixtures/tty-helpers.mts']);
    await proc.stdin.write(enc.encode('partial tty'));
    proc.stdin.close();

    const stdoutChunks: Uint8Array[] = [];
    const stderrChunks: Uint8Array[] = [];
    for await (const chunk of proc.stdout) stdoutChunks.push(chunk);
    for await (const chunk of proc.stderr) stderrChunks.push(chunk);
    const result = await proc.wait();

    t.equal(result.code, 0, 'child exits successfully');
    t.equal(joinChunks(stdoutChunks), 'prompt>stdout:partial tty\n', 'readLine returns partial input on EOF');
    t.equal(joinChunks(stderrChunks), 'stderr:ok\n', 'writeStderr still writes text');
  });
});

describe('fino:tty/prompt', () => {
  function createPromptSession(input: Array<string | null>) {
    const prompts: string[] = [];
    const output: string[] = [];
    const errors: string[] = [];
    const options: PromptSessionOptions = {
      isInteractive: true,
      readLine: async (prompt) => {
        prompts.push(prompt);
        return input.shift() ?? null;
      },
      write: async (text) => { output.push(text); },
      writeError: async (text) => { errors.push(text); },
    };

    return {
      prompt: new PromptSession(options),
      prompts,
      output,
      errors,
    };
  }

  it('answers text prompts with validation retry and defaults', async (t) => {
    const { prompt, prompts, errors } = createPromptSession(['', 'bad', 'valid-name']);
    const options: TextPromptOptions = {
      label: 'Project',
      defaultValue: '',
      validate: (value) => value.length >= 5 ? null : 'Too short',
    };

    const value = await prompt.text(options);

    t.equal(value, 'valid-name', 'valid text response is returned after retries');
    t.deepEqual(prompts, ['Project (): ', 'Project (): ', 'Project (): '], 'text prompt repeats with default hint');
    t.deepEqual(errors, ['Too short\n', 'Too short\n'], 'validation errors are written');
  });

  it('answers confirm prompts with invalid retry and empty defaults', async (t) => {
    const { prompt, prompts, errors } = createPromptSession(['maybe', '']);
    const options: ConfirmPromptOptions = { label: 'Continue', defaultValue: true };

    const value = await prompt.confirm(options);

    t.equal(value, true, 'empty confirm response uses default');
    t.deepEqual(prompts, ['Continue [Y/n]: ', 'Continue [Y/n]: '], 'confirm prompt repeats after invalid input');
    t.deepEqual(errors, ['Please answer yes or no.\n'], 'invalid confirm response is reported');
  });

  it('answers select prompts by retrying invalid choices and accepting labels', async (t) => {
    const { prompt, prompts, output, errors } = createPromptSession(['9', 'HTTP server']);
    const options: SelectPromptOptions = {
      label: 'Template',
      options: [{ label: 'HTTP server', value: 'server' }, 'empty'],
      defaultValue: 'empty',
    };

    const value = await prompt.select(options);

    t.equal(value, 'server', 'select accepts an exact label');
    t.deepEqual(output, ['Template\n', '  1. HTTP server\n', '  2. empty\n'], 'select choices are written once');
    t.deepEqual(prompts, ['Select (empty): ', 'Select (empty): '], 'select prompt retries after invalid input');
    t.deepEqual(errors, ['Please choose one of the listed options.\n'], 'invalid select choice is reported');
  });

  it('answers select prompts by number and exact value', async (t) => {
    const byNumber = createPromptSession(['2']);
    const byValue = createPromptSession(['server']);
    const options: SelectPromptOptions = {
      label: 'Template',
      options: [{ label: 'HTTP server', value: 'server' }, 'empty'],
      defaultValue: 'empty',
    };

    t.equal(await byNumber.prompt.select(options), 'empty', 'select accepts one-based numeric choices');
    t.equal(await byValue.prompt.select(options), 'server', 'select accepts exact values');
  });

  it('uses non-interactive defaults or throws without defaults', async (t) => {
    const prompt = new PromptSession({ isInteractive: false });

    t.equal(await prompt.text({ label: 'Name', defaultValue: 'app' }), 'app', 'text default is returned');
    t.equal(await prompt.confirm({ label: 'Continue', defaultValue: false }), false, 'confirm default is returned');
    t.equal(await prompt.select({ label: 'Template', options: ['empty'], defaultValue: 'empty' }), 'empty', 'select default is returned');
    await t.rejects(
      () => prompt.text({ label: 'Missing' }),
      /Prompt unavailable for "Missing" in non-interactive mode/,
      'missing non-interactive default rejects',
    );
    await t.rejects(
      () => prompt.confirm({ label: 'Continue' }),
      /Prompt unavailable for "Continue" in non-interactive mode/,
      'missing non-interactive confirm default rejects',
    );
    await t.rejects(
      () => prompt.select({ label: 'Template', options: ['empty'] }),
      /Prompt unavailable for "Template" in non-interactive mode/,
      'missing non-interactive select default rejects',
    );
  });
});
