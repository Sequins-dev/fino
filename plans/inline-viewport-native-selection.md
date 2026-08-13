# Native terminal selection for `fino code` (inline viewport)

Status: **researched and prototyped, not implemented.** Written to be picked
up cold.

This is a plan, not published documentation — it lives in `plans/` rather
than `js/*.md` because it describes work that has not been done.

## The problem

`fino code` currently runs fullscreen in the alternate screen with mouse
capture on (modes `1000`/`1002`/`1003`/`1006`). Capture is what gives us
hover affordances, clickable status segments, click-to-expand tool calls, and
sidebar clicks. It is also what takes text selection away from the terminal,
which is why we built an in-app selection with an OSC 52 clipboard write.

That in-app selection is a poor substitute:

- It only copies what is on screen, because the transcript is a repainted
  buffer with no real scrollback.
- It cannot be extended with the terminal's own affordances (double-click a
  word, triple-click a line, shift-click to extend).
- It does not participate in the terminal's find, its scrollback search, or
  anything the user's terminal already does well.
- Nothing survives exiting the app.

## The hard constraint

**A terminal hands the mouse to exactly one owner.** With capture on, drags
go to the application and the terminal stops selecting. With capture off, the
terminal keeps selection, wheel-scroll, and the platform copy chord.

There is no protocol for "let me have hover but leave selection alone", and
no escape sequence that sets the terminal's *native* selection (OSC 52 writes
the clipboard, which is a different thing). Any design that wants real
selection must give up mouse interaction in that region of the screen.

Terminals do offer a per-user escape hatch — holding a modifier bypasses
mouse reporting (Option in iTerm2; Shift in xterm, kitty, GNOME Terminal,
Windows Terminal) — but it is terminal-dependent and undiscoverable, so it is
a mitigation rather than a design.

## What Codex does

Read from `openai/codex` at `codex-rs/tui/` (cloned to `/tmp/codex-src`
during the research; re-clone with `gh repo clone openai/codex`).

**1. It never enables mouse capture. Anywhere.** Zero occurrences of
`MouseCapture`, `EnableMouse`, `?1000h`, `?1002h`, `?1003h`, or `?1006h`
across all of `codex-rs`. `tui/event_stream.rs:250` maps crossterm events and
documents dropping mouse events as "events we don't use". The entire UI is
keyboard-driven. That is the whole trick — there is no clever technique.

**2. Finalized history is written into the terminal's real scrollback.**
`tui/insert_history.rs` says it outright:

> Codex uses the terminal scrollback itself for finalized chat history, so
> inserting a history cell is an escape-sequence operation rather than a
> normal ratatui render.

The mechanism (`insert_history.rs:203` onward): set a scroll region with
DECSTBM covering the rows *above* the live viewport, `MoveTo` the last row of
that region, then emit `\r\n` plus the styled line for each history line, and
reset the region. The cursor is saved and restored so the operation is
position-neutral. Their `HistoryLineWrapPolicy` also has a `Terminal` mode
that leaves lines unwrapped specifically so terminal selection copies the
source faithfully.

**3. The live viewport is a small pinned region at the bottom of the normal
screen buffer** — composer, status, streaming output. `custom_terminal.rs`
carries `viewport_area` and a count of history rows rendered above it.

**4. The alternate screen is only for transient modal overlays** — transcript
overlay (`app_backtrack.rs:219`), resume picker (`resume_picker.rs:760`),
model migration (`model_migration.rs:388`). `tui.rs:780` `enter_alt_screen()`
saves the inline viewport and restores it on leave. There is a
`tui.alternate_screen` config (`always` / `never` / `auto`) and a
`--no-alt-screen` flag gating whether those overlays may use it at all.

## The fino prototype

A throwaway prototype confirmed the mechanism works in fino. Reproduced here
because the original lived in `/tmp`:

```ts
// Bottom N rows are a live viewport repainted in place. Everything else is
// pushed into real scrollback with DECSTBM + \r\n.
import { writeStdout } from 'fino:tty';
import { getTerminalSize, createTuiInput } from 'fino:tty/tui';

const VIEWPORT_ROWS = 3;
const size = getTerminalSize();
const top = size.height - VIEWPORT_ROWS + 1; // 1-based row of the viewport top

await writeStdout('\x1b[2J\x1b[H');

async function printAbove(lines: string[]): Promise<void> {
  let out = '';
  out += `\x1b[1;${top - 1}r`;        // confine scrolling to rows above
  out += `\x1b[${top - 1};1H`;        // park on the region's last row
  for (const line of lines) out += `\r\n${line}\x1b[K`;
  out += '\x1b[r';                    // release the scroll region
  await writeStdout(out);
}

async function paintViewport(text: string[]): Promise<void> {
  let out = '\x1b[s';
  for (let i = 0; i < VIEWPORT_ROWS; i++) {
    out += `\x1b[${top + i};1H\x1b[K${text[i] ?? ''}`;
  }
  out += '\x1b[u';
  await writeStdout(out);
}

const input = createTuiInput({ mouse: false });
// ... read keys, printAbove() on enter, paintViewport() after each event
```

Driven through the PTY harness at 12 rows it behaved correctly: history
accumulated above and scrolled naturally while the composer and status stayed
pinned to the bottom three rows, and the output contained no mouse-mode
sequences.

**Testing this required a harness change that is already committed**
(`0e76d78f`): `tests/tty/harness/pty_driver.py` now models DECSTBM margins,
scrolls the region, keeps what falls off the top as `screen.scrollback()`,
and handles `EL`/`DECSC`/`DECRC`. Without that the emulator treated every
newline as a cursor move and could not represent this layout at all.

What the prototype does **not** prove: that a real terminal's native
selection covers the scrollback rows as expected. A PTY has no selection to
test. The Codex evidence plus the absence of mouse capture makes this
near-certain, but it should be confirmed by hand in iTerm2/Ghostty/Terminal
before building on it.

## Proposed design for fino

Two regions, each with the input model that suits it.

**Chat view — inline, no capture.** The transcript is printed into scrollback
as turns finalize; a pinned viewport at the bottom holds the composer, the
activity indicator, the status bar, and any streaming output not yet
committed. Native selection, native wheel-scroll, native find, and the
transcript survives exit. Keyboard-only.

**Session manager — full viewport, capture on.** Replaces the sidebar. A
session list has nothing worth copying, so it can keep mouse interaction and
gain in-place rename/archive/delete controls, which also retires the context
menu. Entered and left explicitly (a key, `/sessions`), the way Codex enters
the alternate screen for its pickers. Bigger rows can carry summaries, turn
counts, and timestamps.

This is the split Codex arrived at, and it matches the instinct that the
sidebar is the thing that has to go: side-by-side panes are actively hostile
to native selection, because terminals select line-wise and a drag across the
transcript also grabs whatever sits beside it on those rows.

### Framework work (`fino:tty/tui`)

- An inline render mode: `render(view, { inline: rows })` that reserves the
  bottom N rows instead of entering the alternate screen, and repaints only
  that region.
- `app.printAbove(lines)`: the DECSTBM + `\r\n` operation, cursor-neutral.
- Viewport growth/shrink as the composer wraps to more lines.
- Resize handling: the reserved region has to be re-established, and history
  already in scrollback cannot be re-wrapped (see costs).
- Exit path: release the scroll region, leave the cursor below the viewport
  so the shell prompt lands correctly.

### App work (`fino:commands/code`)

- Commit transcript entries to scrollback as they finalize, keeping only
  in-flight output in the viewport.
- Replace every mouse affordance in the chat with a keyboard equivalent:
  tool expansion (the one real gap today), model picker, mode cycling, agent
  selector, steering, scrolling.
- Build the full-viewport session manager and remove the sidebar.
- Decide what happens to sub-agent views, which are currently a tab-like
  switch over the same region.

## Costs, in the order they will bite

1. **Scrollback is immutable.** A line, once printed, cannot be re-rendered.
   Streaming markdown must finalize in the viewport before being committed,
   and progressive re-highlighting (which we just built) applies only to the
   uncommitted tail.
2. **Tool call expansion cannot toggle in place** once committed. Options:
   expand before commit only; always print full output; or re-print detail as
   a fresh block on demand.
3. **Session switching cannot rewrite history.** Switching sessions in a
   shared scrollback is incoherent — hence the modal session manager, and
   probably a clear-and-reprint when a different session is opened.
4. **Terminal resize cannot re-wrap committed history.** Codex pre-wraps to
   the width at commit time and accepts that older lines keep their old wrap.
5. **All mouse affordances in the chat are lost**: hover, clickable status
   segments, click-to-expand, `[steer now]`, and our in-app selection.
6. **Multiplexers need care.** Codex carries a `ZellijRaw` insertion mode
   because Zellij does not constrain soft-wrapped continuation rows to the
   scroll region. tmux and screen should be checked too.

## Open questions

- Does the whole transcript go to scrollback, or only completed turns, with
  the current turn living in the viewport until it settles?
- Do we keep an alternate-screen transcript overlay for search/scroll within
  the app, as Codex does with Ctrl+T?
- Should the inline mode be a flag (`--inline` / `--no-alt-screen`) during the
  transition so both paths are usable while the keyboard equivalents land?
- Does the sub-agent view become part of the modal manager, or a separate
  overlay?

## Suggested sequencing

1. Confirm native selection by hand in the real terminals we care about,
   using the prototype above.
2. Land the framework inline mode plus `printAbove()`, with PTY tests using
   the scroll-region support already in the harness.
3. Add keyboard equivalents for every chat-view mouse affordance, while the
   current UI still works. This is independently useful.
4. Build the modal session manager; remove the sidebar.
5. Switch the chat view to inline rendering and turn capture off.
6. Retire the in-app selection and the OSC 52 copy path.

Steps 2 and 3 are independent and can land in either order; step 5 is the
point of no return and should come last.
