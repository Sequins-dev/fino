/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/disclosure — components that show and hide content:
 * expanders, `Details`, tab strips, and accordions.
 *
 * @internal
 */
import { h, createSignal, type Child, type Props, type Signal, type VNode } from 'fino:ui';
import { Box } from 'internal:ui/components/primitives';
import type { FlexChildProps, StyleProps } from 'internal:ui/components/primitives';

/** Where a disclosure component places its `Expander`. */
export type ExpanderPosition = 'start' | 'end' | 'none';

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
export function Expander(props: ExpanderProps): VNode {
  return h('ui:expander', props);
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
export function Details(props: DetailsProps): VNode {
  return h('ui:details', props);
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
export function TabList(props: TabListProps): VNode {
  return h('ui:tab-list', props);
}

/** Props accepted by `Tabs`. */
export interface TabsProps extends TabListProps {
  children?: Child;
}
/**
 * Tab strip with a content area beneath. The caller renders the active
 * panel as children — there is no hidden panel state.
 */
export function Tabs(props: TabsProps): VNode {
  return h('ui:tabs', props);
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
