---
weight: 41
---
# code

`fino code` starts the Fino coding agent: an interactive terminal assistant
tuned for building applications with Fino and for developing Fino itself. It
discovers modules through the documentation index (`docs_search`,
`docs_show`), reads and edits project files, runs shell commands behind
approval gates, and persists conversation threads in a SQLite store under
`.fino/code/`. With a positional prompt it runs one non-interactive turn and
prints the streamed answer instead of opening the TUI.

```sh
fino code                          # interactive TUI
fino code --plan                   # start in planning mode
fino code --continue               # resume the latest thread
fino code 'what serves HTTP?'      # one streamed turn, then exit
```

Provider credentials come from the environment: `ANTHROPIC_API_KEY` enables
Anthropic models, `OPENAI_API_KEY` and/or `OPENAI_BASE_URL` enable
OpenAI-compatible models (including local servers). `FINO_CODE_MODEL` sets the
default model id.

## Command Reference

| Name | Value | Description |
| --- | --- | --- |
| `prompt...` | string | Run one non-interactive turn with this prompt |
| `--model` | string | Initial model id, e.g. `claude-opus-4-8` |
| `--provider` | string | Provider for `--model` (`anthropic` or `openai`) |
| `--plan` | boolean | Start in planning mode (read-only tools) |
| `--auto` | boolean | Run gated tools without approval prompts |
| `--continue` | boolean | Continue the most recently updated thread |
| `--thread` | string | Continue a specific thread id |
| `--max-cost` | number | Abort once estimated spend exceeds this many USD |
| `--docs-dir` | string | Docs build directory (default `./docs`) |
| `--ephemeral` | boolean | Keep the session in memory instead of SQLite |

## Interactive Commands

Inside the TUI, plain text runs a turn; typing `/` opens a scrollable
autocomplete overlay of the available slash commands above the input
(↑/↓ select, Tab completes, Enter runs). Slash commands control the harness:

- `/model` opens a model picker grouped by provider (chat-capable models
  only), as does clicking the model name in the status bar; `/model <id>`
  switches directly. Each session remembers its model choice and restores
  it when reopened.
- `/plan` and `/code` switch between planning mode (read-only tools, produces
  a plan) and code mode; `Shift+Tab` toggles the same.
- `/auto` toggles auto-approval of gated tools.
- `/new` starts a fresh thread; `/exit` quits.
- `Esc` cancels the running turn; the mouse wheel and `PgUp`/`PgDn` scroll.
- Drag over the transcript to select text; the selection highlights as you
  drag and `Ctrl+E` copies it to the system clipboard (via OSC 52, so it
  works over SSH and inside multiplexers). `Esc` or a click clears it.

Clickable controls — the sidebar toggle and model name in the status bar,
`[steer now]`, tool calls, and sidebar rows — highlight on hover.

Tool activity renders as a call signature with named parameters —
`read_file(path: "js/ai/agent.ts", offset: 10)` — and clicking one expands
it into a format-aware view of its input and output: TypeScript and
JavaScript are syntax-highlighted, Markdown renders as prose, JSON is
pretty-printed, and file reads keep their line numbers beside the source.

When a gated tool (`write_file`, `edit_file`, `shell`) needs approval — the
main agent's or any sub-agent's — the request appears in a blocking popover
over the transcript regardless of the active tab; `y`/`n` are the only inputs
accepted until it is decided, and concurrent requests queue.

## Sessions

Every conversation is a registered session with a durable id and a title
derived from its first prompt. `fino code sessions` lists them
(`--archived` for the history list), `fino code --thread <id>` reopens one,
and `--continue` resumes the most recent. Inside the TUI, `Ctrl+B` or
clicking the `≡` button in the status bar opens the collapsible session
sidebar: a `+ new session` button, then active sessions ordered by recent
activity with `⟳` working / `▲` waiting / `·` idle indicators, each
expanding into its nested sub-agent rows — active children bright, settled
ones dim — with archived sessions in a scrollable history list below.
Several sessions can run turns at once; `Ctrl+N`/`Ctrl+P` (or clicking)
switches focus, and right-clicking a session opens a context menu to
rename, archive, or delete it (delete removes the thread and its sub-agent
data from the store; JSONL transcripts remain on disk). `/new`, `/archive`,
and `/title <name>` do the same from the keyboard. macOS reserves
Ctrl+arrow combinations for Mission Control, so the TUI avoids them.

## Sub-agents

The agent can fan work out to concurrent sub-agents (`fino:ai/subagents`),
each a durable conversation between the parent agent and a child agent —
mirroring how the main chat is a conversation between you and the parent.
Every sub-agent gets its own read-only view (cycle with `Tab`, or select it
in the sidebar; sub-agents are agent-driven, so their views have no input
box). Children default to the
parent's model and inherit the parent's mode: planning-mode parents spawn
read-only children. When a child believes its task is done it reports a
summary and waits; the parent reviews and either finalizes the child or
keeps iterating with follow-up messages.

Sub-agents persist across turns. A parent turn can end with its children
quiescent, and after you provide more input the parent can revive any of
them — including finalized ones — with `subagent_send`, continuing the same
child conversation with its full context. Idle children hold no resources;
revival reattaches them from the store.

The turn stays active while sub-agents work — if the parent stops early, the
engine waits for the children to settle and automatically continues the
conversation with a settlement summary so nothing goes unreviewed. `Esc` in
a sub-agent view cancels that child's run; `/agents` lists all sub-agents.

## Queueing and steering

While a turn is active, `Enter` queues your message instead of sending it.
Queued messages render above the input with a clickable `[steer now]` action
(`Ctrl+S` steers the oldest): steering injects the message into the running
turn at the next step boundary, redirecting the agent mid-turn. Whatever is
still queued when the turn ends is sent as the next turn. The parent agent
steers its sub-agents the same way through `subagent_send`.

## Durability and transcripts

Threads, sub-agent conversations, and pending approvals all persist in the
session store. After a crash or Ctrl-C, `fino code --continue` re-drives an
interrupted run from its last checkpoint, re-presents a pending approval
popover, restores sub-agent views, and resumes children that were mid-run.

Alongside the authoritative SQLite store, every session mirrors its timeline
to append-only JSONL transcripts under `.fino/code/transcripts/` —
`<session>.jsonl` for the main conversation and `<session>/<child>.jsonl`
per sub-agent, one event per line (user input, steering, assistant messages,
tool activity, approvals, sub-agent status). Transcripts are human-readable,
greppable, and auditable by the agent itself through its own file tools;
they are a mirror, so deleting them loses nothing operational.
`--no-transcripts` disables the mirror.

## Documentation Index

The docs tools search the SQLite full-text index produced by `fino doc build`.
In a project without one, run:

```sh
fino doc build --types runtime-builtins.d.ts js   # in the fino repository
```

or point `--docs-dir` at an existing build. Without an index the agent still
works; the docs tools report how to create one.
