/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/disclosure — components that show and hide content:
 * expanders, `Details`, tab strips, and accordions.
 *
 * @internal
 */
import { h, createSignal, type Child, type Props, type Signal, type VNode } from 'fino:ui';
import {
  actionForm,
  actionsActive,
  handlerOf,
  idAttr,
  register,
} from 'internal:ui/components/html-runtime';
import { Box } from 'internal:ui/components/primitives';
import type { FlexChildProps, StyleProps } from 'internal:ui/components/primitives';

/** Where a disclosure component places its `Expander`. */
export type ExpanderPosition = 'start' | 'end' | 'none';

function expanderMark(open: boolean): VNode {
  return h('span', {
    className: `ui-expander${open ? ' is-open' : ''}`,
    'aria-hidden': 'true',
  });
}

function summaryRow(title: string, open: boolean, where: ExpanderPosition): NormalizedChild[] {
  const out: NormalizedChild[] = [];
  if (where === 'start') out.push(expanderMark(open));
  out.push(h('span', { className: 'ui-details-title' }, title));
  if (where === 'end') out.push(expanderMark(open));
  return out;
}

function tabStrip(items: TabItem[], value: string, onChange: unknown): VNode {
  const change = handlerOf<(key: string) => void>(onChange);
  const entries = items.map((item) => {
    const className =
      'ui-tab' +
      (item.key === value ? ' is-active' : '') +
      (item.disabled === true ? ' is-disabled' : '');
    const switchable = change !== undefined && item.key !== value && item.disabled !== true;
    if (actionsActive() && switchable) {
      const act = register(() => change!(item.key));
      return h('button', { className, name: 'do', value: act }, item.label);
    }
    if (switchable) return h('a', { href: '#', className }, item.label);
    return h('span', { className }, item.label);
  });
  const nav = h('nav', { className: 'ui-tabs' }, ...entries);
  return actionsActive() && change !== undefined ? actionForm({}, nav) : nav;
}

/** Props accepted by `Expander`. */
export interface ExpanderProps extends StyleProps, FlexChildProps, Props {
  open: boolean;
  onToggle?: (open: boolean) => void;
  disabled?: boolean;
  id?: string;
}
/**
 * Standalone disclosure affordance: the rotating open/closed marker,
 * placeable anywhere in a composition. Clickable when `onToggle` is given.
 */
export function Expander(all: ExpanderProps): VNode {
  const { children = [], ...props } = all as ExpanderProps & { children?: NormalizedChild[] };
  const { open, onToggle, disabled, id } = props;
  const toggle = handlerOf<(next: boolean) => void>(onToggle);
  if (actionsActive() && toggle !== undefined && disabled !== true) {
    const act = register(() => toggle(open !== true));
    return actionForm(
      {},
      h('button', {
        className: `ui-expander${open === true ? ' is-open' : ''}`,
        name: 'do',
        value: act,
        'aria-label': open === true ? 'Collapse' : 'Expand',
        ...idAttr(id),
      }),
    );
  }
  const mark = expanderMark(open === true);
  if (typeof id === 'string') mark.props.id = id;
  return mark;
}

/** Props accepted by `Details`. */
export interface DetailsProps extends StyleProps, FlexChildProps, Props {
  title: string;
  open: boolean;
  onToggle?: (open: boolean) => void;
  /** Expander placement in the summary row; default `'start'`. */
  expander?: ExpanderPosition;
  focused?: boolean;
  id?: string;
  children?: Child;
}
/**
 * Collapsible section: an always-visible summary that toggles the content
 * beneath it, like an HTML `<details>` element.
 */
export function Details(all: DetailsProps): VNode {
  const { children = [], ...props } = all as DetailsProps & { children?: NormalizedChild[] };
  const { title, open, onToggle, expander, id } = props;
  const where: ExpanderPosition = expander ?? 'start';
  const toggle = handlerOf<(next: boolean) => void>(onToggle);
  const attrs: Props = { className: 'ui-details', ...idAttr(id) };
  if (open === true) attrs.open = true;
  const body = h('div', { className: 'ui-details-body' }, ...children);
  if (actionsActive() && toggle !== undefined) {
    // The summary is one big submit button: clicks round-trip instead of
    // toggling natively, so the server's open state never desyncs.
    const act = register(() => toggle(open !== true));
    return h(
      'details',
      attrs,
      h(
        'summary',
        { className: 'ui-details-summary' },
        actionForm(
          {},
          h(
            'button',
            { className: 'ui-details-toggle ui-row', name: 'do', value: act },
            ...summaryRow(title, open === true, where),
          ),
        ),
      ),
      body,
    );
  }
  return h(
    'details',
    attrs,
    h(
      'summary',
      { className: 'ui-details-summary ui-row' },
      ...summaryRow(title, open === true, where),
    ),
    body,
  );
}

/** One tab in a `Tabs` strip. */
export interface TabItem {
  key: string;
  label: string;
  disabled?: boolean;
}

/** Props accepted by `TabList`. */
export interface TabListProps extends StyleProps, FlexChildProps, Props {
  items: TabItem[];
  value: string;
  onChange?: (key: string) => void;
  id?: string;
}
/** The tab strip alone: one active tab among labeled peers. */
export function TabList(all: TabListProps): VNode {
  const { children = [], ...props } = all as TabListProps & { children?: NormalizedChild[] };
  const { items, value, onChange } = props;
  return tabStrip(items, value, onChange);
}

/** Props accepted by `Tabs`. */
export interface TabsProps extends TabListProps {
  children?: Child;
}
/**
 * Tab strip with a content area beneath. The caller renders the active
 * panel as children — there is no hidden panel state.
 */
export function Tabs(all: TabsProps): VNode {
  const { children = [], ...props } = all as TabsProps & { children?: NormalizedChild[] };
  const { items, value, onChange } = props;
  return h(
    'div',
    { className: 'ui-tabs-wrap' },
    tabStrip(items, value, onChange),
    h('div', { className: 'ui-tab-panel' }, ...children),
  );
}

/** Disclosure state helper for `Details`, `Modal`, `Select`, and menus. */
export interface Disclosure {
  readonly open: Signal<boolean>;
  toggle(): void;
  set(open: boolean): void;
}
/** Create toggleable open/closed state that survives re-renders. */
export function createDisclosure(defaultOpen = false): Disclosure {
  const open = createSignal(defaultOpen);
  return {
    open,
    toggle: () => open.set(!open.get()),
    set: (next: boolean) => open.set(next),
  };
}

/** One section of an `Accordion`. */
export interface AccordionSection {
  key: string;
  title: string;
  content: Child;
}
/** Props accepted by `Accordion`. */
export interface AccordionProps extends FlexChildProps, Props {
  sections: AccordionSection[];
  openKeys: string[];
  onToggle?: (key: string) => void;
  /** Expander placement forwarded to every section's `Details`. */
  expander?: ExpanderPosition;
  id?: string;
}
/**
 * Stack of `Details` sections. The caller owns `openKeys` — pair with
 * `createAccordion(true)` when only one section may stay open.
 */
export function Accordion(props: AccordionProps): VNode {
  const { sections, openKeys, onToggle, expander, id, ...rest } = props;
  return (
    <Box direction="column" id={id} {...rest}>
      {sections.map((section) => (
        <Details
          key={section.key}
          id={id !== undefined ? `${id}:${section.key}` : undefined}
          title={section.title}
          open={openKeys.includes(section.key)}
          expander={expander}
          onToggle={onToggle ? () => onToggle(section.key) : undefined}
        >
          {section.content}
        </Details>
      ))}
    </Box>
  );
}

/** Accordion open-key state helper. */
export interface AccordionState {
  readonly openKeys: Signal<string[]>;
  toggle(key: string): void;
}
/** Create accordion open-key state; `single` closes other sections on toggle. */
export function createAccordion(single = false): AccordionState {
  const openKeys = createSignal<string[]>([]);
  return {
    openKeys,
    toggle(key: string): void {
      const current = openKeys.get();
      if (current.includes(key)) {
        openKeys.set(current.filter((open) => open !== key));
      } else {
        openKeys.set(single ? [key] : [...current, key]);
      }
    },
  };
}
