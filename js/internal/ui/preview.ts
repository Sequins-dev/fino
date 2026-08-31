/**
 * internal:ui/preview — the preview vocabulary the component preview is built
 * from.
 *
 * A preview is one named demonstration of a component, optionally exposing
 * controls so the same component can be viewed under several configurations
 * without writing a preview per configuration. Previews live beside the
 * components they demonstrate (`js/ui/components/*.previews.tsx`), and
 * `fino:ui/preview` composes every group into the browsable catalog. The
 * types live here rather than in the preview so a previews file does not have
 * to import the preview's runners — and so the preview can import the
 * previews without a cycle.
 *
 * @internal
 */
import type { VNode } from 'fino:ui';

/** A value a preview control can hold. */
export type ControlValue = string | number | boolean;

/**
 * An adjustable input a preview exposes, so a component can be viewed under
 * different configurations without writing a preview per configuration.
 */
export type Control =
  | { type: 'boolean'; label?: string; default: boolean }
  | { type: 'text'; label?: string; default: string }
  | { type: 'number'; label?: string; default: number; step?: number; min?: number; max?: number }
  | { type: 'select'; label?: string; options: string[]; default: string };

/** The current values of a preview's controls, passed to its view. */
export type PreviewArgs = Record<string, ControlValue>;

/**
 * One named component demonstration. `view` receives the current control
 * values; a preview without controls receives an empty object.
 */
export interface Preview {
  key: string;
  name: string;
  controls?: Record<string, Control>;
  view: (args: PreviewArgs) => VNode;
}

/** A titled group of previews. */
export interface PreviewGroup {
  title: string;
  previews: Preview[];
}

/** The default argument values a preview's controls declare. */
export function defaultArgs(preview: Preview): PreviewArgs {
  const args: PreviewArgs = {};
  for (const [name, control] of Object.entries(preview.controls ?? {})) {
    args[name] = control.default;
  }
  return args;
}

function clampNumber(control: Extract<Control, { type: 'number' }>, value: number): number {
  let out = value;
  if (control.max !== undefined) out = Math.min(out, control.max);
  if (control.min !== undefined) out = Math.max(out, control.min);
  return out;
}

/** Parse control values from strings (query params, CLI args). */
export function parseArgs(preview: Preview, raw: Record<string, string>): PreviewArgs {
  const args = defaultArgs(preview);
  for (const [name, control] of Object.entries(preview.controls ?? {})) {
    const value = raw[name];
    if (value === undefined) continue;
    if (control.type === 'boolean') args[name] = value === 'true' || value === 'on';
    else if (control.type === 'number') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) args[name] = clampNumber(control, parsed);
    } else if (control.type === 'select') {
      if (control.options.includes(value)) args[name] = value;
    } else args[name] = value;
  }
  return args;
}
