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

/** Selected preview and its parsed control values. */
export interface PreviewSelection {
  preview: Preview | undefined;
  args: PreviewArgs;
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

/** Find a preview by its catalog-wide key. */
export function findPreview(
  groups: readonly PreviewGroup[],
  key: string | null,
): Preview | undefined {
  for (const group of groups) {
    for (const preview of group.previews) {
      if (preview.key === key) return preview;
    }
  }
  return undefined;
}

/** Select a requested preview or the catalog's first entry, then parse controls. */
export function selectPreview(
  groups: readonly PreviewGroup[],
  key: string | null,
  raw: Record<string, string> = {},
): PreviewSelection {
  const preview =
    findPreview(groups, key) ?? groups.find((group) => group.previews.length > 0)?.previews[0];
  return { preview, args: preview === undefined ? {} : parseArgs(preview, raw) };
}

/** Validate custom preview modules and enforce catalog-wide key uniqueness. */
export function validatePreviewGroups(value: unknown): PreviewGroup[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError('preview groups must be a non-empty array');
  }
  const keys = new Set<string>();
  for (const group of value as unknown[]) {
    if (typeof group !== 'object' || group === null) {
      throw new TypeError('each preview group must be an object');
    }
    const candidate = group as { title?: unknown; previews?: unknown };
    if (
      typeof candidate.title !== 'string' ||
      !Array.isArray(candidate.previews) ||
      candidate.previews.length === 0
    ) {
      throw new TypeError('each preview group needs a title and non-empty previews array');
    }
    for (const preview of candidate.previews as unknown[]) {
      if (typeof preview !== 'object' || preview === null) {
        throw new TypeError(`preview entries in ${candidate.title} must be objects`);
      }
      const entry = preview as { key?: unknown; name?: unknown; view?: unknown };
      if (
        typeof entry.key !== 'string' ||
        entry.key.length === 0 ||
        typeof entry.name !== 'string' ||
        typeof entry.view !== 'function'
      ) {
        throw new TypeError(`preview entries in ${candidate.title} need key, name, and view`);
      }
      if (keys.has(entry.key)) throw new TypeError(`duplicate preview key: ${entry.key}`);
      keys.add(entry.key);
    }
  }
  return value as PreviewGroup[];
}
