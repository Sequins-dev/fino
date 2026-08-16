/**
 * internal:ui/components/navigation — breadcrumbs, pagers, and step strips.
 *
 * @internal
 */
import { h, type NormalizedChild, type Props, type VNode } from 'fino:ui';
import {
  actionForm,
  actionsActive,
  handlerOf,
  idAttr,
  register,
} from 'internal:ui/components/html-runtime';
import type { FlexChildProps } from 'internal:ui/components/primitives';

/** Props accepted by `Breadcrumbs`. */
export interface BreadcrumbsProps extends FlexChildProps, Props {
  items: Array<{ key: string; label: string }>;
  onNavigate?: (key: string) => void;
  id?: string;
}
/** Path row: clickable ancestors, then the current item. */
export function Breadcrumbs(all: BreadcrumbsProps): VNode {
  const { children = [], ...props } = all as BreadcrumbsProps & { children?: NormalizedChild[] };
  const { items, onNavigate, id } = props;
  const navigate = handlerOf<(key: string) => void>(onNavigate);
  const nav = h(
    'nav',
    { className: 'ui-crumbs', 'aria-label': 'breadcrumbs', ...idAttr(id) },
    ...items.flatMap((item, index) => {
      let entry: VNode;
      if (index === items.length - 1) {
        entry = h('strong', null, item.label);
      } else if (actionsActive() && navigate !== undefined) {
        const act = register(() => navigate(item.key));
        entry = h('button', { className: 'ui-crumb', name: 'do', value: act }, item.label);
      } else if (navigate !== undefined) {
        entry = h('a', { href: '#', className: 'ui-crumb' }, item.label);
      } else {
        entry = h('span', { className: 'ui-crumb' }, item.label);
      }
      return index > 0 ? [h('span', { className: 'ui-crumbs-sep' }, '/'), entry] : [entry];
    }),
  );
  return actionsActive() && navigate !== undefined ? actionForm({}, nav) : nav;
}

/** Props accepted by `Pagination`. */
export interface PaginationProps extends FlexChildProps, Props {
  page: number;
  pages: number;
  onChange: (page: number) => void;
  /** Pages shown on each side of the current page. Defaults to 1. */
  siblings?: number;
  id?: string;
}
/**
 * Pager: a previous chevron, direct page buttons with `…` where pages are
 * skipped, and a next chevron. The current page is highlighted and inert;
 * chevrons disable at the boundaries and `…` markers are inert. See
 * `paginationRange` for the exact sequence rule.
 */
export function Pagination(all: PaginationProps): VNode {
  const { children = [], ...props } = all as PaginationProps & { children?: NormalizedChild[] };
  const { page, pages, onChange, siblings, id } = props;
  const change = handlerOf<(page: number) => void>(onChange);
  const total = Math.max(1, Math.floor(pages));
  const current = Math.min(Math.max(1, Math.floor(page)), total);
  const range = paginationRange(current, total, siblings);
  const step = (target: number, blocked: boolean, label: string): VNode => {
    const attrs: Props = { className: 'ui-button ui-pager-step' };
    if (actionsActive() && change !== undefined && !blocked) {
      attrs.name = 'do';
      attrs.value = register(() => change(target));
    } else {
      attrs.type = 'button';
      if (blocked || change === undefined) attrs.disabled = true;
    }
    return h('button', attrs, label);
  };
  const pageButton = (target: number): VNode => {
    const isCurrent = target === current;
    const attrs: Props = {
      className: `ui-button ui-pager-page${isCurrent ? ' is-current' : ''}`,
    };
    if (isCurrent) attrs['aria-current'] = 'page';
    if (actionsActive() && change !== undefined && !isCurrent) {
      attrs.name = 'do';
      attrs.value = register(() => change(target));
    } else {
      attrs.type = 'button';
      if (isCurrent || change === undefined) attrs.disabled = true;
    }
    return h('button', attrs, String(target));
  };
  const nav = h(
    'nav',
    { className: 'ui-pager', ...idAttr(id) },
    step(current - 1, current <= 1, '‹'),
    ...range.map((entry) =>
      entry === 'ellipsis' ? h('span', { className: 'ui-pager-ellipsis' }, '…') : pageButton(entry),
    ),
    step(current + 1, current >= total, '›'),
  );
  return actionsActive() && change !== undefined ? actionForm({}, nav) : nav;
}

/**
 * Compute the page-button sequence for `Pagination`: the first page, a
 * window of `siblings` pages either side of `page` (default 1), and the
 * last page — with an `'ellipsis'` marker wherever the window skips more
 * than one page. A skip of exactly one page is shown as that page instead
 * of collapsing it into `…`, since an ellipsis only earns its place when it
 * hides two or more pages.
 *
 * `page` clamps into `[1, pages]` and `pages` clamps to at least 1, so a
 * one-page (or zero/negative-page) pager degenerates to `[1]`.
 *
 * ```ts no_run
 * paginationRange(7, 20, 1); // [1, 'ellipsis', 6, 7, 8, 'ellipsis', 20]
 * paginationRange(2, 3, 1);  // [1, 2, 3]
 * ```
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
  if (left - 2 === 1) left -= 1;
  if (total - right - 1 === 1) right += 1;
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

/** Props accepted by `Steps`. */
export interface StepsProps extends FlexChildProps, Props {
  steps: Array<{ key: string; label: string }>;
  current: string;
  id?: string;
}
/** Step strip: done, current, and upcoming steps in order. */
export function Steps(all: StepsProps): VNode {
  const { children = [], ...props } = all as StepsProps & { children?: NormalizedChild[] };
  const { steps, current, id } = props;
  const at = steps.findIndex((step) => step.key === current);
  return h(
    'ol',
    { className: 'ui-steps', ...idAttr(id) },
    ...steps.map((step, index) => {
      const state =
        at !== -1 && index < at ? 'is-done' : index === at ? 'is-current' : 'is-upcoming';
      return h(
        'li',
        { className: state },
        h('span', { className: 'ui-step-dot' }),
        h('span', null, step.label),
      );
    }),
  );
}
