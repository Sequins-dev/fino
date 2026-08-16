/**
 * internal:ui/story — the story vocabulary the component gallery is built
 * from.
 *
 * A story is one named demonstration of a component, optionally exposing
 * controls so the same component can be viewed under several configurations
 * without writing a story per configuration. Stories live beside the
 * components they demonstrate (`js/ui/components/*.stories.tsx`), and
 * `fino:ui/gallery` composes every group into the browsable catalog. The
 * types live here rather than in the gallery so a stories file does not have
 * to import the gallery's runners — and so the gallery can import the
 * stories without a cycle.
 *
 * @internal
 */
import type { VNode } from 'fino:ui';

/** A value a story control can hold. */
export type ControlValue = string | number | boolean;

/**
 * An adjustable input a story exposes, so a component can be viewed under
 * different configurations without writing a story per configuration.
 */
export type Control =
  | { type: 'boolean'; label?: string; default: boolean }
  | { type: 'text'; label?: string; default: string }
  | { type: 'number'; label?: string; default: number; step?: number; min?: number; max?: number }
  | { type: 'select'; label?: string; options: string[]; default: string };

/** The current values of a story's controls, passed to its view. */
export type StoryArgs = Record<string, ControlValue>;

/**
 * One named component demonstration. `view` receives the current control
 * values; a story without controls receives an empty object.
 */
export interface Story {
  key: string;
  name: string;
  controls?: Record<string, Control>;
  view: (args: StoryArgs) => VNode;
}

/** A titled group of stories. */
export interface StoryGroup {
  title: string;
  stories: Story[];
}

/** The default argument values a story's controls declare. */
export function defaultArgs(story: Story): StoryArgs {
  const args: StoryArgs = {};
  for (const [name, control] of Object.entries(story.controls ?? {})) {
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
export function parseArgs(story: Story, raw: Record<string, string>): StoryArgs {
  const args = defaultArgs(story);
  for (const [name, control] of Object.entries(story.controls ?? {})) {
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
