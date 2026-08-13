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

- `/model` opens a full-screen model picker grouped by provider
  (chat-capable models only); `/model <id>` switches directly. The catalog
  is fetched once in the background at startup and reused, so the picker
  opens populated; `Ctrl+R` inside it re-fetches. Each session remembers its
  model choice and restores it when reopened.
- `/plan`, `/build`, and `/auto` set the mode; `Shift+Tab` cycles through
  them.
- `/agents` or `Ctrl+G` opens the agent selector below the input.
- `/sessions` or `Ctrl+B` opens the session manager; `/new` starts a fresh
  thread; `/exit` quits.
- `/debug` reports the viewport size and terminal identity.
- `Esc` cancels the running turn.
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

## The inline surface

The chat runs inline in the terminal's primary buffer rather than in a
fullscreen alternate screen. Finished output — your messages, settled
markdown, completed tool calls, turn markers — is committed into the
terminal's own scrollback and never repainted; only a small footer at the
bottom (the streaming tail, activity indicator, queued messages, selectors,
input, and status bar) is redrawn in place. Because the app never captures
the mouse in the chat, the terminal keeps everything it normally owns:
select text natively (double-click a word, triple-click a line), copy with
the platform chord, scroll with the wheel or your scrollback keys, search
the transcript with the terminal's find, and keep the whole conversation in
scrollback after the app exits. The cost is that committed lines are
immutable — they keep the width they were committed at across resizes, and
tool output shows its detail only while the tool runs.

While a turn runs, the footer shows the streaming tail of the assistant's
message — markdown blocks commit to scrollback as they settle, so what is
above the footer is final and what is inside it may still re-render — and a
spinner line naming what the agent is doing: the running tool, elapsed time,
active sub-agents, queued messages. A long pause reads as work rather than a
freeze. When the turn ends the tail flushes, the footer shrinks, and a greyed
`✔ <duration>` marker is committed to the transcript. Each turn's outcome,
duration, and position in the history is recorded in the session store
beside the conversation, so reopening a thread restores the markers; the
JSONL mirror carries the same thing as a `turn_end` event. Code inside a
fence is syntax-highlighted before the closing fence arrives, and a
horizontal rule marks the start of each prose answer.

The status bar names the project directory, the model, the mode (the one
colored word — magenta for plan, cyan for build, red for auto), and the
sub-agent count, plus transient notes. At its right edge sit four attention
dots for the *other* sessions: yellow lights when one is busy, blue when one
needs input (an approval or a suspension), red when one errored, and green
when one finished a turn you have not looked at yet. Switching to a session
clears its dot.

Menus — the slash-command overlay, the agent selector, the model picker, and
the session manager — share one selection model: a `▸` marker at the head of
the row turns white on the selected entry and `Enter` acts on it. In the
mouse-enabled overlay views, hovering moves the same selection and clicking
acts on it.

Tool activity renders as a call signature with named parameters —
`read_file(path: "js/ai/agent.ts", offset: 10)`. While the tool runs, its
input and live output detail show in the footer; the committed transcript
form is the signature plus a short output preview, which keeps scrollback
compact and selectable.

When a gated tool (`write_file`, `edit_file`, `shell`) needs approval — the
main agent's or any sub-agent's — the composer area transforms into a
yellow approval band naming the requesting agent, the tool, and its
arguments; `y`/`n` are the only inputs accepted until it is decided,
concurrent requests queue, and the decision is committed to the transcript
as a record.

## Sessions

Every conversation is a session with a durable id and a title derived from
its first prompt. A session joins the registry when that first message runs,
not when it is created, so opening the app and closing it again leaves no
empty session behind. `fino code sessions` lists them (`--archived` for the
history list), `fino code --thread <id>` reopens one, and `--continue`
resumes the most recent.

Inside the TUI, `Ctrl+B` or `/sessions` opens the full-screen session
manager — one of the two views that keeps mouse interaction (the other is
the model picker). Sessions render as full-width cards ordered by recent
activity, each carrying its title, an activity glyph in the attention
colors (`⟳` busy / `▲` needs input / `✗` error / `●` done-unseen / `·`
idle), a relative timestamp, and its model. Controls are in place: `Enter`
(or a click) opens the selected session, `r` renames it inline, `a`
archives or unarchives, `d` pressed twice deletes (removing the thread and
its sub-agent data from the store; JSONL transcripts remain on disk), and
`n` or the `+ new session` card starts a blank chat — it becomes a session
when you send its first message. Below the active list, a collapsible
`archived (n)` row expands to the archived sessions.

Archiving freezes a session: its engine is released, so nothing is running
behind it, and opening it from the manager replays the conversation
read-only with no input line. Unarchiving, or opening it with `--thread`,
brings the agent back and continues the same thread.

Several sessions can run turns at once; `Ctrl+N`/`Ctrl+P` switches between
them directly, printing a divider and replaying the target's transcript
into scrollback — old content stays above it, the way `cat` output
accumulates. `/new`, `/archive`, and `/title <name>` work from the
keyboard. macOS reserves Ctrl+arrow combinations for Mission Control, so
the TUI avoids them.

## Sub-agents

The agent can fan work out to concurrent sub-agents (`fino:ai/subagents`),
each a durable conversation between the parent agent and a child agent —
mirroring how the main chat is a conversation between you and the parent.
Every sub-agent gets its own read-only view. `/agents` or `Ctrl+G` opens a
selector listing the session and its sub-agents with their statuses;
picking one (or cycling with `Tab`) prints that conversation's divider and
transcript into scrollback. Sub-agents are agent-driven, so their views
have no input box. Children default to
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
Queued messages render dimly above the input; `Ctrl+S` steers the oldest:
steering injects the message into the running turn at the next step
boundary, redirecting the agent mid-turn. Whatever is
still queued when the turn ends is sent as the next turn. The parent agent
steers its sub-agents the same way through `subagent_send`.

## Durability and transcripts

Threads, sub-agent conversations, and pending approvals all persist in the
session store. After a crash or Ctrl-C, `fino code --continue` re-drives an
interrupted run from its last checkpoint, re-presents a pending approval
band, restores sub-agent views, and resumes children that were mid-run.

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
