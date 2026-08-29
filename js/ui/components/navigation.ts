/** Host-neutral breadcrumbs, pagination, and step components. @internal */
import { h } from 'fino:ui';
import type { Props, VNode } from 'fino:ui';
import type { FlexChildProps, StyleProps } from 'fino:ui/components';

/** One labeled navigation destination. */
export interface NavigationItem {
  key: string;
  label: string;
}

/** Props accepted by {@link Breadcrumbs}. */
export interface BreadcrumbsProps extends StyleProps, FlexChildProps, Props {
  items: readonly NavigationItem[];
  onNavigate?: (key: string) => void;
}

/** Path row whose final item is the current location. */
export function Breadcrumbs(props: BreadcrumbsProps): VNode {
  return h('ui:breadcrumbs', props);
}

/** Props accepted by {@link Pagination}. */
export interface PaginationProps extends StyleProps, FlexChildProps, Props {
  page: number;
  pages: number;
  onChange?: (page: number) => void;
  /** Pages retained on each side of the current page; defaults to one. */
  siblings?: number;
}

/** Previous, numbered, and next page controls. */
export function Pagination(props: PaginationProps): VNode {
  return h('ui:pagination', props);
}

/**
 * Compute a compact page sequence containing the boundaries and a window
 * around the current page.
 */
export function paginationRange(
  page: number,
  pages: number,
  siblings = 1,
): Array<number | 'ellipsis'> {
  const total = Math.max(1, Math.floor(pages));
  const current = Math.min(Math.max(1, Math.floor(page)), total);
  const span = Math.max(0, Math.floor(siblings));
  let left = Math.max(1, current - span);
  let right = Math.min(total, current + span);
  if (left - 2 === 1) left--;
  if (total - right - 1 === 1) right++;
  const range: Array<number | 'ellipsis'> = [];
  if (left > 1) {
    range.push(1);
    if (left > 2) range.push('ellipsis');
  }
  for (let index = left; index <= right; index++) range.push(index);
  if (right < total) {
    if (right < total - 1) range.push('ellipsis');
    range.push(total);
  }
  return range;
}

/** Props accepted by {@link Steps}. */
export interface StepsProps extends StyleProps, FlexChildProps, Props {
  steps: readonly NavigationItem[];
  current: string;
}

/** Ordered progress strip with done, current, and upcoming steps. */
export function Steps(props: StepsProps): VNode {
  return h('ui:steps', props);
}
