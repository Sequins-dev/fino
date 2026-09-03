/**
 * Target-neutral vocabulary for co-located component previews.
 *
 * @internal
 */
import type { VNode } from 'fino:ui';

/** Value accepted by a preview control. */
export type ControlValue = string | number | boolean;

/** Adjustable preview control definition. */
export type Control =
  | { type: 'boolean'; label?: string; default: boolean }
  | { type: 'text'; label?: string; default: string }
  | { type: 'number'; label?: string; default: number; step?: number; min?: number; max?: number }
  | { type: 'select'; label?: string; options: string[]; default: string };

/** Current preview control values. */
export type PreviewArgs = Record<string, ControlValue>;

/** One named component demonstration. */
export interface Preview {
  key: string;
  name: string;
  controls?: Record<string, Control>;
  view: (args: PreviewArgs) => VNode;
}

/** Titled family of previews. */
export interface PreviewGroup {
  title: string;
  previews: Preview[];
}

/** Return the declared default values for a preview. */
export function defaultArgs(preview: Preview): PreviewArgs {
  return Object.fromEntries(
    Object.entries(preview.controls ?? {}).map(([name, control]) => [name, control.default]),
  );
}

/** Parse string inputs using the preview control declarations. */
export function parseArgs(preview: Preview, raw: Record<string, string>): PreviewArgs {
  const args = defaultArgs(preview);
  for (const [name, control] of Object.entries(preview.controls ?? {})) {
    const value = raw[name];
    if (value === undefined) continue;
    if (control.type === 'boolean') args[name] = value === 'true' || value === 'on';
    else if (control.type === 'number') {
      const parsed = Number(value);
      if (!Number.isFinite(parsed)) continue;
      args[name] = Math.max(control.min ?? -Infinity, Math.min(control.max ?? Infinity, parsed));
    } else if (control.type === 'select') {
      if (control.options.includes(value)) args[name] = value;
    } else args[name] = value;
  }
  return args;
}
