/**
 * internal:commands/code/ui/theme — the `fino code` styling vocabulary.
 *
 * Every color decision the app makes routes through this module, on top of
 * the base tokens from `fino:tty/components/theme`. Mode colors, the
 * four-state attention palette, tool state marks, and sub-agent glyphs live
 * here so each surface renders the same state the same way.
 */
import { tk } from 'fino:tty/components/theme';
import type { CodeMode } from 'fino:commands/code/engine';
import type { SubagentState } from 'fino:ai/subagents';

/** The mode is the one colored word in the status bar. */
export const MODE_COLORS: Record<CodeMode, string> = {
  plan: tk.magenta,
  build: tk.cyan,
  auto: tk.red,
};

/** Cycle order for the mode dial. */
export const MODE_ORDER: CodeMode[] = ['plan', 'build', 'auto'];

/** One-line description per mode, for `/help` and mode flashes. */
export const MODE_HELP: Record<CodeMode, string> = {
  plan: 'plan mode: read-only tools (sub-agents inherit read-only)',
  build: 'build mode: full tool set, gated tools ask first',
  auto: 'auto mode: full tool set, gated tools run without asking',
};

/** Session attention states surfaced as status-bar dots and list glyphs. */
export type AttentionKind = 'input' | 'error' | 'done' | 'busy';

/** Color per attention state: blue needs-input, red error, green done, yellow busy. */
export const ATTENTION: Record<AttentionKind, string> = {
  input: tk.blue,
  error: tk.red,
  done: tk.green,
  busy: tk.yellow,
};

/**
 * Attention states in precedence order, most urgent first.
 *
 * The status bar shows one dot for the whole workspace, so when several
 * background sessions want attention at once it reports the one that most
 * needs a decision: being asked a question outranks a failure, which outranks
 * a result waiting to be read, which outranks work still in progress.
 */
export const ATTENTION_RANK: AttentionKind[] = ['input', 'error', 'done', 'busy'];

/** Bullet color per tool state. */
export const TOOL_MARKS: Record<'running' | 'ok' | 'error', string> = {
  running: tk.yellow,
  ok: tk.green,
  error: tk.red,
};

/** Status glyph per sub-agent state. */
export const CHILD_GLYPHS: Record<SubagentState['status'], string> = {
  working: '⟳',
  awaiting_approval: '?',
  awaiting_review: '✔',
  done: '●',
  failed: '✗',
  cancelled: '✗',
};

/** Head of every menu row; white marks the selection, grey the rest. */
export const MENU_MARKER = '▸';
