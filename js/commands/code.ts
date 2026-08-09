/**
 * fino:commands/code — the `fino code` coding-agent command.
 *
 * `fino code` starts an interactive terminal coding assistant tuned for the
 * Fino platform: it discovers modules through the documentation index,
 * reads and edits project files, runs shell commands behind approval gates,
 * switches models between turns through the `fino:ai` model registry, and
 * persists conversation threads in a SQLite session store. With a positional
 * prompt it instead runs one non-interactive turn and prints the streamed
 * answer, which suits scripting and piping.
 *
 * The interactive UI lives in `fino:commands/code/tui`, turn execution in
 * `fino:commands/code/engine`, and the tool set in
 * `fino:commands/code/tools`; this module only defines the CLI surface.
 *
 * ```ts no_run
 * import code from 'fino:commands/code';
 *
 * await code.parse(['what does fino:realm provide?', '--auto']);
 * ```
 */
import { Task, type TaskContext } from '../task.ts';
import { cwd } from '../process.ts';
import { stdinIsTTY, stdoutIsTTY } from '../tty.ts';
import type { AgentEvent } from 'fino:ai/runtime';
import type { CodeEngine as CodeEngineType } from 'fino:commands/code/engine';

interface CodeCommandInput {
  prompt?: string[];
  model?: string;
  provider?: string;
  plan?: boolean;
  auto?: boolean;
  continue?: boolean;
  thread?: string;
  'max-cost'?: number;
  'docs-dir'?: string;
  ephemeral?: boolean;
}

const command = new Task({
  name: 'code',
  description: 'Start the Fino coding agent (interactive TUI, or one turn with a prompt)',
  outputMode: 'both',
  run: async function runCodeCommand(input: CodeCommandInput, ctx) {
    const root = ctx.cwd ?? cwd();
    const { CodeEngine } = await import('fino:commands/code/engine');
    const engine = await CodeEngine.create({
      cwd: root,
      model: input.model,
      provider: input.provider,
      planMode: input.plan ?? false,
      auto: input.auto ?? false,
      maxCostUsd: input['max-cost'],
      docsDir: input['docs-dir'],
      sessionDb: input.ephemeral ? false : undefined,
      threadId: input.thread,
      continueThread: input.continue ?? false,
    });
    const prompt = (input.prompt ?? []).join(' ').trim();
    if (prompt.length === 0) {
      if (!stdinIsTTY || !stdoutIsTTY) {
        await engine.close();
        throw new Error('fino code: interactive mode needs a TTY; pass a prompt for one-shot use');
      }
      const { runCodeTui } = await import('fino:commands/code/tui');
      await runCodeTui(engine);
      return ctx.writer.mode === 'json'
        ? { command: 'code', ok: true, threadId: engine.threadId }
        : '';
    }
    try {
      return await runOneShot(engine, prompt, ctx);
    } finally {
      await engine.close();
    }
  },
  cli: {
    usage: 'fino code [options] [prompt...]',
    options: [
      { flags: '--model', type: 'string', description: 'Initial model id (e.g. claude-opus-4-8)' },
      {
        flags: '--provider',
        type: 'string',
        description: 'Provider for --model (anthropic | openai)',
      },
      { flags: '--plan', type: 'boolean', description: 'Start in planning mode (read-only tools)' },
      { flags: '--auto', type: 'boolean', description: 'Run gated tools without approval prompts' },
      { flags: '--continue', type: 'boolean', description: 'Continue the most recent thread' },
      { flags: '--thread', type: 'string', description: 'Continue a specific thread id' },
      {
        flags: '--max-cost',
        type: 'number',
        description: 'Abort once estimated spend exceeds this many USD',
      },
      { flags: '--docs-dir', type: 'string', description: 'Docs build directory (default ./docs)' },
      {
        flags: '--ephemeral',
        type: 'boolean',
        description: 'Keep the session in memory instead of SQLite',
      },
    ],
    positionals: [
      {
        name: 'prompt',
        type: 'string',
        multiple: true,
        description: 'Run one non-interactive turn with this prompt',
      },
    ],
  },
});

async function runOneShot(
  engine: CodeEngineType,
  prompt: string,
  ctx: TaskContext,
): Promise<string | Record<string, unknown>> {
  const json = ctx.writer.mode === 'json';
  let streamed = '';
  const onEvent = (ev: AgentEvent): void => {
    if (ev.type === 'model_event' && ev.event.type === 'text_delta') {
      streamed += ev.event.text;
      if (!json) void ctx.writer.writeText?.(ev.event.text);
    } else if (ev.type === 'tool_start' && !json) {
      void ctx.writer.writeText?.(`\n[tool: ${ev.name}]\n`);
    }
  };
  let result = await engine.runTurn(prompt, { onEvent, signal: ctx.signal });
  while (result.status === 'suspended' && result.approval) {
    const req = result.approval.request;
    const summary = `${req.toolName} ${JSON.stringify(req.args ?? {})}`;
    let approved = false;
    if (ctx.prompt?.isInteractive) {
      approved = await ctx.prompt.confirm({
        label: `Approve ${summary}?`,
        defaultValue: false,
      });
    }
    result = approved
      ? await engine.approve(result.approval.token, { signal: ctx.signal })
      : await engine.reject(
          result.approval.token,
          'not approved in non-interactive mode; rerun with --auto',
          { signal: ctx.signal },
        );
  }
  const text = result.text ?? streamed;
  if (json) {
    return {
      command: 'code',
      ok: result.status === 'done',
      status: result.status,
      threadId: engine.threadId,
      text,
    };
  }
  await ctx.writer.writeText?.('\n');
  return '';
}

export { command as default };
