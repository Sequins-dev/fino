/**
 * fino:commands/code — the `fino code` coding-agent command.
 *
 * `fino code` starts an interactive terminal coding assistant tuned for the
 * Fino platform: it discovers modules through the documentation index,
 * reads and edits project files, runs shell commands behind approval gates,
 * switches models between turns through the `fino:ai` model registry, fans
 * work out to sub-agents, and persists everything durably — SQLite session
 * threads plus JSONL transcript mirrors. Sessions are registered in a
 * workspace: `fino code sessions` lists them, `--thread <id>` reopens one,
 * `--continue` resumes the most recent, and the TUI sidebar works across
 * several at once. With a positional prompt it instead runs one
 * non-interactive turn and prints the streamed answer.
 *
 * The interactive UI lives in `internal:commands/code/tui`, turn execution in
 * `internal:commands/code/engine`, the session registry in
 * `internal:commands/code/workspace`, and the tool set in
 * `internal:commands/code/tools`; this module only defines the CLI surface.
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
import type {
  CodeEngine as CodeEngineType,
  TurnResult as TurnResultType,
} from 'internal:commands/code/engine';
import type { CodeWorkspace as CodeWorkspaceType } from 'internal:commands/code/workspace';

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
  'no-transcripts'?: boolean;
}

async function openWorkspace(input: CodeCommandInput, root: string): Promise<CodeWorkspaceType> {
  const { CodeWorkspace } = await import('internal:commands/code/workspace');
  return CodeWorkspace.open({
    cwd: root,
    model: input.model,
    provider: input.provider,
    mode: input.auto ? 'auto' : input.plan ? 'plan' : 'build',
    maxCostUsd: input['max-cost'],
    docsDir: input['docs-dir'],
    sessionDb: input.ephemeral ? false : undefined,
    transcriptsDir: input['no-transcripts'] ? false : undefined,
  });
}

const sessionsCommand = new Task({
  name: 'sessions',
  description: 'List fino code sessions in this project',
  outputMode: 'both',
  run: async function runSessionsCommand(input: { archived?: boolean }, ctx) {
    const root = ctx.cwd ?? cwd();
    const workspace = await openWorkspace({}, root);
    try {
      const sessions = workspace.list({ archived: input.archived ?? false });
      if (ctx.writer.mode === 'json') {
        return { command: 'code sessions', ok: true, sessions };
      }
      if (sessions.length === 0) {
        return input.archived ? 'No archived sessions.' : 'No sessions yet — run `fino code`.';
      }
      const lines = sessions.map((s) => {
        const updated = new Date(s.updatedAt).toISOString().replace('T', ' ').slice(0, 16);
        return `${s.id}  ${updated}  ${s.title}`;
      });
      return [
        'id' +
          ' '.repeat(Math.max(1, (sessions[0]?.id.length ?? 20) - 2)) +
          '  updated           title',
        ...lines,
        '',
        'Reopen one with: fino code --thread <id>',
      ].join('\n');
    } finally {
      await workspace.close();
    }
  },
  cli: {
    usage: 'fino code sessions [--archived]',
    options: [
      { flags: '--archived', type: 'boolean', description: 'List archived sessions instead' },
    ],
  },
});

const command = new Task({
  name: 'code',
  description: 'Start the Fino coding agent (interactive TUI, or one turn with a prompt)',
  outputMode: 'both',
  run: async function runCodeCommand(input: CodeCommandInput, ctx) {
    const root = ctx.cwd ?? cwd();
    const workspace = await openWorkspace(input, root);
    const continuing = Boolean(input.continue || input.thread);
    let engine: CodeEngineType;
    if (input.thread) {
      engine = await workspace.openSession(input.thread);
    } else if (input.continue) {
      engine = (await workspace.openLatest()) ?? (await workspace.createSession());
    } else {
      engine = await workspace.createSession();
    }
    const prompt = (input.prompt ?? []).join(' ').trim();
    if (prompt.length === 0) {
      if (!stdinIsTTY || !stdoutIsTTY) {
        await workspace.close();
        throw new Error('fino code: interactive mode needs a TTY; pass a prompt for one-shot use');
      }
      const { runCodeTui } = await import('internal:commands/code/tui');
      await runCodeTui(workspace, {
        sessionId: engine.threadId,
        recover: continuing,
      });
      return ctx.writer.mode === 'json'
        ? { command: 'code', ok: true, threadId: engine.threadId }
        : '';
    }
    try {
      return await runOneShot(engine, prompt, ctx);
    } finally {
      await workspace.close();
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
      { flags: '--plan', type: 'boolean', description: 'Start in plan mode (read-only tools)' },
      { flags: '--auto', type: 'boolean', description: 'Start in auto mode (no approval prompts)' },
      { flags: '--continue', type: 'boolean', description: 'Continue the most recent session' },
      { flags: '--thread', type: 'string', description: 'Continue a specific session id' },
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
      {
        flags: '--no-transcripts',
        type: 'boolean',
        description: 'Disable the JSONL transcript mirror',
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
  children: [sessionsCommand],
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
  const settleApprovals = async (turn: TurnResultType): Promise<TurnResultType> => {
    let current = turn;
    while (current.status === 'suspended' && current.approval) {
      const req = current.approval.request;
      const summary = `${req.toolName} ${JSON.stringify(req.args ?? {})}`;
      let approved = false;
      if (ctx.prompt?.isInteractive) {
        approved = await ctx.prompt.confirm({
          label: `Approve ${summary}?`,
          defaultValue: false,
        });
      }
      current = approved
        ? await engine.approve(current.approval.token, { signal: ctx.signal })
        : await engine.reject(
            current.approval.token,
            'not approved in non-interactive mode; rerun with --auto',
            { signal: ctx.signal },
          );
    }
    return current;
  };
  const recovered = await engine.recoverTurn({ onEvent, signal: ctx.signal });
  if (recovered) await settleApprovals(recovered);
  const result = await settleApprovals(
    await engine.runTurn(prompt, { onEvent, signal: ctx.signal }),
  );
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
