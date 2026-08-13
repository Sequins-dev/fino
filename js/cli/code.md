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
fino code --plan                   # start in plan mode
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
| `--plan` | boolean | Start in plan mode (read-only tools) |
| `--auto` | boolean | Start in auto mode (gated tools run unprompted) |
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
  switches directly. The catalog is fetched once in the background at
  startup and reused, so the picker opens populated; `Ctrl+R` inside it
  re-fetches. Each session remembers its model choice and restores it when
  reopened.
- `/plan`, `/build`, and `/auto` set the mode. `Shift+Tab` and clicking the
  mode in the status bar cycle through them.
- `/agents` opens the agent selector; so does clicking the agent count in the
  status bar.
- `/new` starts a fresh thread; `/exit` quits.
- `/debug` reports the viewport size, terminal identity, and a count of the
  input events received so far — useful when mouse affordances misbehave,
  since a `move` count that stays at zero means the terminal does not report
  pointer motion (mode 1003) and hover cannot light up.
- `Esc` cancels the running turn; the mouse wheel and `PgUp`/`PgDn` scroll.
- The input is a full editor line: the cursor moves with `←`/`→`, jumps words
  with `Alt`+arrow, and selects with `Shift` held — including `Shift`+`Alt`,
  which extends the selection a word at a time. Typing replaces a selection,
  and `Shift` or `Alt` with `Backspace`/`Delete` removes a word at a time in
  either direction.
  Long input wraps to as many rows as it needs, `↑`/`↓` walk those rows, and
  `Shift`+`Enter` inserts a line break. At the top or bottom row, where there
  is no line left to move to, `↑`/`↓` recall previously sent messages
  instead; that history is rebuilt from the thread when a session is
  reopened, so it survives restarts.
- Drag over the transcript to select text. The selection highlights as you
  drag and is copied to the system clipboard as soon as you release, via
  OSC 52 — so it works over SSH and inside multiplexers. The terminal
  intercepts the platform copy chord (`Cmd+C` on macOS) before the app sees
  it and copies the terminal's own selection, which is why the copy happens
  on release rather than on a keypress; `Ctrl+E` re-copies the current
  selection. `Esc` or a click clears it. A selection stays inside the pane it
  started in, the way a scroll container bounds one in a browser, so dragging
  across the transcript never picks up the sidebar beside it.

While a turn runs, a spinner sits above the input showing what the agent is
doing — the running tool, elapsed time, active sub-agents, queued messages —
so a long pause reads as work rather than a freeze. When the turn ends the
indicator moves into the transcript as a greyed `✔ <duration>` line, so it
scrolls with the conversation and stays put ahead of the next message.
Each turn's outcome, duration, and position in the history is recorded in the
session store beside the conversation, so reopening a thread restores the
markers; the JSONL mirror carries the same thing as a `turn_end` event. Assistant messages are highlighted as they stream: markdown
blocks render as they settle, and code inside a fence is syntax-highlighted
before the closing fence arrives. A horizontal rule marks the start of each
prose answer.

The status bar names the project directory, the model, the mode, and the
sub-agent count, plus transient notes like a copy confirmation. It keeps the
terminal's own background — the mode is the one colored word, magenta for
plan, cyan for build, red for auto. Per-session state lives in the sidebar
rather than here, where it would only describe the session already on
screen. Clickable controls — the `≡ <project>` sidebar button, the model, the
mode, the agent count, `[steer now]`, tool calls, and sidebar rows —
highlight on hover, brightening rather than filling in.

Menus — the slash-command overlay, the model picker, the agent selector, and
the session context menu — share one selection model: a `▸` marker at the head
of the row turns white on the selected entry, hovering brightens a row and
moves the selection to it, and clicking or `Enter` acts on whatever is
selected. Pointer and keyboard drive the same choice rather than two
competing ones.

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

Every conversation is a session with a durable id and a title derived from
its first prompt. A session joins the registry when that first message runs,
not when it is created, so opening the app and closing it again leaves no
empty session behind. `fino code sessions` lists them (`--archived` for the
history list), `fino code --thread <id>` reopens one, and `--continue`
resumes the most recent.

Inside the TUI, `Ctrl+B` or clicking the `≡ <project>` button in the status
bar opens the collapsible session sidebar: a `+ new session` card, then
sessions as bordered cards ordered by recent activity with `⟳` working /
`▲` waiting / `·` idle indicators — the signal for which conversation wants
attention. Cards are borderless at rest, gain a grey border under the
pointer, and a white one when focused. `+ new session` opens a blank chat
rather than creating a session — it becomes one when you send its first
message. Below the active list, a collapsible `archived (n)` section expands
in place to show archived sessions.

Archiving freezes a session: its engine is released, so nothing is running
behind it, and selecting it shows the conversation read-only with no input
line — the whole column goes to the transcript. Its context menu offers only
`Unarchive` and `Delete`, since renaming would mean thawing it. Unarchiving,
or opening it with `--thread`, brings the agent back and continues the same
thread.
Several sessions can run turns at once; `Ctrl+N`/`Ctrl+P` (or clicking)
switches focus, and right-clicking a session opens a context menu over the
row itself to rename, archive, or delete it (delete removes the thread and its sub-agent
data from the store; JSONL transcripts remain on disk). `/new`, `/archive`,
and `/title <name>` do the same from the keyboard. macOS reserves
Ctrl+arrow combinations for Mission Control, so the TUI avoids them.

## Sub-agents

The agent can fan work out to concurrent sub-agents (`fino:ai/subagents`),
each a durable conversation between the parent agent and a child agent —
mirroring how the main chat is a conversation between you and the parent.
Every sub-agent gets its own read-only view. The agent count in the status
bar (or `/agents`) opens a selector listing the session and its sub-agents
with their statuses; picking one switches the transcript to that
conversation. Sub-agents are agent-driven, so their views have no input box —
the row it would occupy goes to the transcript instead. Children default to
the parent's model and inherit the parent's mode: plan-mode parents spawn
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
