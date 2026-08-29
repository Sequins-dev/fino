/**
 * Shared selection and dismissal mechanics for interactive components.
 *
 * @internal
 */
import type { UiKeyEvent } from 'fino:ui/components';

/** Item contract understood by list-selection helpers. */
export interface SelectableKey {
  /** Stable item identity. */
  key: string;
  /** Whether the item must be skipped by navigation. */
  disabled?: boolean;
}

/** Return enabled item keys without repeating filtering policy at each control. */
export function selectableKeys(items: readonly SelectableKey[]): string[] {
  return items.filter((item) => item.disabled !== true).map((item) => item.key);
}

/**
 * Move a selected key through enabled items, clamping at either boundary.
 * A missing selection starts immediately before the first item when moving
 * forward and immediately after the last item when moving backward.
 */
export function moveSelectedKey(
  items: readonly SelectableKey[],
  selected: string | null | undefined,
  delta: number,
): string | null {
  const keys = selectableKeys(items);
  if (keys.length === 0) return null;
  const found = selected === null || selected === undefined ? -1 : keys.indexOf(selected);
  const start = found === -1 ? (delta < 0 ? keys.length : -1) : found;
  const next = Math.max(0, Math.min(keys.length - 1, start + delta));
  return keys[next] ?? null;
}

/** Build the shared Escape-only dismissal handler used by floating surfaces. */
export function dismissOnEscape(
  onDismiss: (() => void) | undefined,
): ((event: UiKeyEvent) => boolean) | undefined {
  if (onDismiss === undefined) return undefined;
  return (event): boolean => {
    if (event.key !== 'escape') return false;
    onDismiss();
    return true;
  };
}
