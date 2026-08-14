/**
 * internal:commands/code/ui/views/session-manager — the full-screen session view.
 *
 * Replaces the old sidebar: a mouse-enabled overlay listing every session as
 * a full-width card with in-place controls — Enter opens, `r` renames inline,
 * `a` archives/unarchives, `d` (twice) deletes, `n` or the `+` card starts a
 * new session. Archived sessions collapse behind a header row after the
 * active list. Card borders carry the selection state: invisible at rest,
 * white when selected — the same border-only affordance the sidebar used.
 */
import type { TerminalSize, TuiKeyEvent, TuiMouseEvent } from 'fino:tty/tui';
import { tk, style } from 'fino:tty/components/theme';
import { clipAnsi, padAnsi, wrapPlain } from 'fino:tty/components/text';
import { Composer } from 'fino:tty/components/composer';
import type { HitRegion, RenderedPane } from 'fino:tty/components/pane';
import type { OverlayView } from 'internal:commands/code/ui/overlay';
import { ATTENTION } from 'internal:commands/code/ui/theme';
import type { CodeSessionActivity, CodeSessionMeta } from 'fino:commands/code/workspace';

/** Everything the manager needs from the app controller. */
export interface SessionManagerOptions {
  projectName: string;
  list(opts?: { archived?: boolean }): CodeSessionMeta[];
  activityFor(id: string): CodeSessionActivity;
  /** Open a session (unarchives if needed) and close the overlay. */
  onOpen(id: string): void;
  /** Show an archived session read-only and close the overlay. */
  onOpenArchived(id: string): void;
  onNew(): void;
  onRename(id: string, title: string): void;
  onArchive(id: string, archived: boolean): void;
  onDelete(id: string): void;
}

type Row =
  | { kind: 'new' }
  | { kind: 'session'; id: string; archived: boolean }
  | { kind: 'archive-header'; count: number };

const TITLE_LINES = 2;

function activityGlyph(activity: CodeSessionActivity): string {
  switch (activity) {
    case 'working':
      return `${ATTENTION.busy}⟳${tk.reset}`;
    case 'waiting':
      return `${ATTENTION.input}▲${tk.reset}`;
    case 'error':
      return `${ATTENTION.error}✗${tk.reset}`;
    case 'done':
      return `${ATTENTION.done}●${tk.reset}`;
    default:
      return style('·', tk.dim);
  }
}

function relativeTime(then: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * The session manager overlay view. Construct fresh on open; it reads the
 * registry through its options on every render, so workspace changes only
 * need an `OverlayController.refresh()`.
 */
export class SessionManagerView implements OverlayView {
  #opts: SessionManagerOptions;
  #selected = 0;
  #scroll = 0;
  #archiveExpanded = false;
  #confirmDelete: string | null = null;
  #renaming: { id: string; composer: Composer } | null = null;
  #rows: Row[] = [];
  #rowLines: number[] = [];

  /** Create the view over the app's session registry callbacks. */
  constructor(opts: SessionManagerOptions) {
    this.#opts = opts;
  }

  #buildRows(): Row[] {
    const rows: Row[] = [{ kind: 'new' }];
    for (const meta of this.#opts.list()) {
      rows.push({ kind: 'session', id: meta.id, archived: false });
    }
    const archived = this.#opts.list({ archived: true });
    if (archived.length > 0) {
      rows.push({ kind: 'archive-header', count: archived.length });
      if (this.#archiveExpanded) {
        for (const meta of archived) rows.push({ kind: 'session', id: meta.id, archived: true });
      }
    }
    return rows;
  }

  #selectedRow(): Row | undefined {
    return this.#rows[this.#selected];
  }

  #cardLines(row: Row, width: number, selected: boolean, now: number): string[] {
    const inner = width - 4;
    const border = selected ? tk.white : '';
    const edge = (text: string): string =>
      border === '' ? text : `${border}${text}${tk.reset}`;
    const top = edge(`┌${'─'.repeat(width - 2)}┐`);
    const bottom = edge(`└${'─'.repeat(width - 2)}┘`);
    const wrap = (body: string): string =>
      `${edge('│')} ${padAnsi(clipAnsi(body, inner), inner)} ${edge('│')}`;
    if (row.kind === 'new') {
      return [top, wrap(`${tk.green}+${tk.reset} new session`), bottom];
    }
    if (row.kind === 'archive-header') {
      const chevron = this.#archiveExpanded ? '▾' : '▸';
      return [style(`  ${chevron} archived (${row.count})`, tk.dim)];
    }
    const meta =
      this.#opts.list().find((m) => m.id === row.id) ??
      this.#opts.list({ archived: true }).find((m) => m.id === row.id);
    if (!meta) return [];
    const lines: string[] = [top];
    if (this.#renaming !== null && this.#renaming.id === row.id) {
      const [first] = this.#renaming.composer.render({ width: inner, placeholder: 'new title' });
      lines.push(wrap(first ?? ''));
    } else {
      const glyph = row.archived ? style('■', tk.dim) : activityGlyph(this.#opts.activityFor(row.id));
      const titleLines = wrapPlain(meta.title, inner - 2).slice(0, TITLE_LINES);
      lines.push(wrap(`${glyph} ${titleLines[0] ?? ''}`));
      for (const line of titleLines.slice(1)) lines.push(wrap(`  ${line}`));
    }
    const detail = [
      relativeTime(meta.updatedAt, now),
      ...(meta.model !== undefined ? [meta.model] : []),
      ...(row.archived ? ['archived'] : []),
      ...(this.#confirmDelete === row.id ? [`${tk.red}press d again to delete${tk.reset}`] : []),
    ].join(' · ');
    lines.push(wrap(style(detail, tk.dim)));
    lines.push(bottom);
    return lines;
  }

  /** Render the manager at `size` with hit regions per card. */
  render(size: TerminalSize): RenderedPane {
    const now = Date.now();
    const width = Math.max(30, size.width);
    this.#rows = this.#buildRows();
    if (this.#selected >= this.#rows.length) this.#selected = Math.max(0, this.#rows.length - 1);
    const header = [
      ` ${style(this.#opts.projectName, tk.bold, tk.white)} ${style('· sessions', tk.dim)}`,
      '',
    ];
    const hint = style(
      ' ↑/↓ select · Enter open · r rename · a archive · d delete twice · n new · Esc close',
      tk.dim,
    );
    const bodyHeight = Math.max(1, size.height - header.length - 1);
    const blocks: string[][] = [];
    this.#rowLines = [];
    for (let index = 0; index < this.#rows.length; index++) {
      const block = this.#cardLines(this.#rows[index]!, width - 2, index === this.#selected, now);
      this.#rowLines.push(block.length);
      blocks.push(block);
    }
    // Scroll by whole rows so a card is never split across the fold.
    if (this.#selected < this.#scroll) this.#scroll = this.#selected;
    for (;;) {
      let used = 0;
      for (let index = this.#scroll; index <= this.#selected && index < blocks.length; index++) {
        used += blocks[index]!.length;
      }
      if (used <= bodyHeight || this.#scroll >= this.#selected) break;
      this.#scroll += 1;
    }
    const lines = [...header];
    const hits: HitRegion[] = [];
    let row = header.length;
    for (let index = this.#scroll; index < blocks.length; index++) {
      const block = blocks[index]!;
      if (row + block.length > header.length + bodyHeight) break;
      const target = this.#rows[index]!;
      const key =
        target.kind === 'new' ? 'new' : target.kind === 'archive-header' ? 'archive' : `s:${target.id}`;
      for (const line of block) {
        hits.push({ row, startCol: 0, endCol: width, key });
        lines.push(` ${line}`);
        row += 1;
      }
    }
    while (lines.length < size.height - 1) lines.push('');
    lines.push(hint);
    return { lines: lines.slice(0, size.height), hits };
  }

  #open(row: Row): 'close' | 'handled' {
    if (row.kind === 'new') {
      this.#opts.onNew();
      return 'close';
    }
    if (row.kind === 'archive-header') {
      this.#archiveExpanded = !this.#archiveExpanded;
      return 'handled';
    }
    if (row.archived) {
      this.#opts.onOpenArchived(row.id);
      return 'close';
    }
    this.#opts.onOpen(row.id);
    return 'close';
  }

  /** Keyboard interaction for the manager. */
  handleKey(event: TuiKeyEvent): 'close' | 'handled' {
    if (this.#renaming !== null) {
      if (event.key === 'escape') {
        this.#renaming = null;
        return 'handled';
      }
      if (event.key === 'enter') {
        const title = this.#renaming.composer.text.trim();
        if (title.length > 0) this.#opts.onRename(this.#renaming.id, title);
        this.#renaming = null;
        return 'handled';
      }
      this.#renaming.composer.handleKey(event, 60);
      return 'handled';
    }
    const row = this.#selectedRow();
    this.#confirmDelete = event.key === 'd' ? this.#confirmDelete : null;
    switch (event.key) {
      case 'escape':
        return 'close';
      case 'up':
        this.#selected = Math.max(0, this.#selected - 1);
        return 'handled';
      case 'down':
        this.#selected = Math.min(this.#rows.length - 1, this.#selected + 1);
        return 'handled';
      case 'enter':
        return row !== undefined ? this.#open(row) : 'handled';
      case 'n':
        this.#opts.onNew();
        return 'close';
      case 'r':
        if (row !== undefined && row.kind === 'session' && !row.archived) {
          const composer = new Composer();
          const meta = this.#opts.list().find((m) => m.id === row.id);
          if (meta) composer.buffer.setText(meta.title);
          this.#renaming = { id: row.id, composer };
        }
        return 'handled';
      case 'a':
        if (row !== undefined && row.kind === 'session') {
          this.#opts.onArchive(row.id, !row.archived);
        }
        return 'handled';
      case 'u':
        if (row !== undefined && row.kind === 'session' && row.archived) {
          this.#opts.onArchive(row.id, false);
        }
        return 'handled';
      case 'd':
        if (row !== undefined && row.kind === 'session') {
          if (this.#confirmDelete === row.id) {
            this.#confirmDelete = null;
            this.#opts.onDelete(row.id);
          } else {
            this.#confirmDelete = row.id;
          }
        }
        return 'handled';
      default:
        return 'handled';
    }
  }

  /** Hover selects; click opens; wheel steps the selection. */
  handleMouse(event: TuiMouseEvent, hitKey: string | undefined): 'close' | 'handled' {
    if (event.action === 'wheel') {
      this.#selected = Math.max(
        0,
        Math.min(this.#rows.length - 1, this.#selected + (event.button === 'wheel-down' ? 1 : -1)),
      );
      return 'handled';
    }
    if (hitKey === undefined) return 'handled';
    const index = this.#rows.findIndex((row) => {
      const key = row.kind === 'new' ? 'new' : row.kind === 'archive-header' ? 'archive' : `s:${row.id}`;
      return key === hitKey;
    });
    if (index >= 0) this.#selected = index;
    if (event.action === 'press' && event.button === 'left') {
      const row = this.#rows[index];
      if (row !== undefined) return this.#open(row);
    }
    return 'handled';
  }
}
