/**
 * internal:commands/code/ui/views/model-picker — the full-screen model chooser.
 *
 * A mouse-enabled overlay over the async provider catalog: models grouped
 * under provider headers, the current model marked, `Enter` (or a click)
 * selects, `Ctrl+R` re-fetches the catalog. Loading and failure states
 * render in place so a slow or broken provider listing never blocks input.
 */
import type { TerminalSize, TuiKeyEvent, TuiMouseEvent } from 'fino:tty/tui';
import type { ModelInfo } from 'fino:ai/model';
import { tk, style } from 'fino:tty/components/theme';
import { SelectList, type ListItem } from 'fino:tty/components/list';
import type { RenderedPane } from 'fino:tty/components/pane';
import type { OverlayView } from 'internal:commands/code/ui/overlay';

/** Wiring for the picker: catalog access and the pick callback. */
export interface ModelPickerOptions {
  currentModel(): string;
  /** Fetch (or re-fetch) the catalog; cached by the caller. */
  load(force: boolean): Promise<ModelInfo[]>;
  onPick(id: string): void;
  /** Repaint request while an async load resolves. */
  refresh(): void;
}

function catalogItems(models: ModelInfo[], current: string): ListItem[] {
  const byProvider = new Map<string, string[]>();
  for (const info of models) {
    const list = byProvider.get(info.provider) ?? [];
    list.push(info.id);
    byProvider.set(info.provider, list);
  }
  const items: ListItem[] = [];
  // Plain codepoint order: this V8 build has no ICU collation, so
  // localeCompare() throws rather than sorting.
  for (const [provider, ids] of [...byProvider.entries()].sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  )) {
    items.push({ kind: 'header', label: provider });
    for (const id of ids.sort()) {
      items.push({ kind: 'item', key: id, label: id, current: id === current });
    }
  }
  return items;
}

/** The model picker overlay view. */
export class ModelPickerView implements OverlayView {
  #opts: ModelPickerOptions;
  #list: SelectList;
  #loading = true;
  #error: string | null = null;

  /** Create the picker and start loading the catalog. */
  constructor(opts: ModelPickerOptions) {
    this.#opts = opts;
    this.#list = new SelectList({ maxRows: 16 });
    this.#load(false);
  }

  #load(force: boolean): void {
    this.#loading = true;
    this.#error = null;
    this.#opts
      .load(force)
      .then((models) => {
        this.#loading = false;
        this.#list.setItems(catalogItems(models, this.#opts.currentModel()));
        this.#list.selectKey(this.#opts.currentModel());
        this.#opts.refresh();
      })
      .catch((err: unknown) => {
        this.#loading = false;
        this.#error = err instanceof Error ? err.message : String(err);
        this.#opts.refresh();
      });
  }

  /** Render the picker at `size`. */
  render(size: TerminalSize): RenderedPane {
    const width = Math.max(30, size.width);
    const header = [
      ` ${style('select model', tk.bold, tk.white)} ${style(`· current ${this.#opts.currentModel()}`, tk.dim)}`,
      '',
    ];
    const hint = style(' ↑/↓ select · Enter choose · Ctrl+R refresh · Esc close', tk.dim);
    let body: string[];
    let hits: RenderedPane['hits'] = [];
    if (this.#loading) {
      body = [style(' loading models…', tk.dim)];
    } else if (this.#error !== null) {
      body = [style(` failed to list models: ${this.#error}`, tk.red), style(' Ctrl+R retries', tk.dim)];
    } else {
      // The picker owns the whole screen, so the list takes every row left
      // between the header and the blank row above the key hint.
      this.#list.setMaxRows(Math.max(1, size.height - header.length - 2));
      const pane = this.#list.render(width - 2);
      body = pane.lines.map((line) => ` ${line}`);
      hits = pane.hits.map((hit) => ({
        ...hit,
        row: hit.row + header.length,
        startCol: hit.startCol + 1,
        endCol: hit.endCol + 1,
      }));
    }
    const lines = [...header, ...body];
    // A blank row always separates the list from the key hint, whether the
    // list fills the screen or stops short of it.
    while (lines.length < size.height - 1) lines.push('');
    lines[size.height - 2] = '';
    lines.push(hint);
    return { lines: lines.slice(0, size.height), hits };
  }

  /** Keyboard interaction for the picker. */
  handleKey(event: TuiKeyEvent): 'close' | 'handled' {
    if (event.key === 'escape') return 'close';
    if (event.key === 'r' && event.ctrl) {
      this.#load(true);
      return 'handled';
    }
    if (event.key === 'up') {
      this.#list.move(-1);
      return 'handled';
    }
    if (event.key === 'down') {
      this.#list.move(1);
      return 'handled';
    }
    if (event.key === 'pageup') {
      this.#list.movePage(-1);
      return 'handled';
    }
    if (event.key === 'pagedown') {
      this.#list.movePage(1);
      return 'handled';
    }
    if (event.key === 'enter') {
      const key = this.#list.selectedKey;
      if (key !== undefined) {
        this.#opts.onPick(key);
        return 'close';
      }
    }
    return 'handled';
  }

  /** Hover selects; click picks; wheel steps. */
  handleMouse(event: TuiMouseEvent, hitKey: string | undefined): 'close' | 'handled' {
    if (event.action === 'wheel') {
      this.#list.move(event.button === 'wheel-down' ? 1 : -1);
      return 'handled';
    }
    if (hitKey !== undefined) this.#list.selectKey(hitKey);
    if (event.action === 'press' && event.button === 'left' && hitKey !== undefined) {
      this.#opts.onPick(hitKey);
      return 'close';
    }
    return 'handled';
  }
}
