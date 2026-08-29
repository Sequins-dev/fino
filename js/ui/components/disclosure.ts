/**
 * Host-neutral disclosure, tab, and accordion components.
 *
 * @internal
 */
import { createSignal, h } from 'fino:ui';
import type { Child, Props, Signal, VNode } from 'fino:ui';
import { Box } from 'fino:ui/components';
import type { FlexChildProps, StyleProps } from 'fino:ui/components';

/** Where a disclosure component places its expander. */
export type ExpanderPosition = 'start' | 'end' | 'none';

/** Props accepted by {@link Expander}. */
export interface ExpanderProps extends StyleProps, FlexChildProps, Props {
  /** Controlled expanded state. */
  open: boolean;
  /** Called with the next expanded state. */
  onToggle?: (open: boolean) => void;
  /** Whether interaction is disabled. */
  disabled?: boolean;
}

/** Standalone open/closed disclosure affordance. */
export function Expander(props: ExpanderProps): VNode {
  return h('ui:expander', props);
}

/** Props accepted by {@link Details}. */
export interface DetailsProps extends StyleProps, FlexChildProps, Props {
  /** Always-visible summary label. */
  title: string;
  /** Controlled expanded state. */
  open: boolean;
  /** Called with the next expanded state. */
  onToggle?: (open: boolean) => void;
  /** Expander placement; defaults to `start`. */
  expander?: ExpanderPosition;
  /** Whether the summary is painted as focused. */
  focused?: boolean;
  /** Content revealed while open. */
  children?: Child;
}

/** Collapsible summary and content section. */
export function Details(props: DetailsProps): VNode {
  return h('ui:details', props);
}

/** One entry in a tab strip. */
export interface TabItem {
  /** Stable tab identity. */
  key: string;
  /** Visible tab label. */
  label: string;
  /** Whether the tab is inert. */
  disabled?: boolean;
}

/** Props accepted by {@link TabList}. */
export interface TabListProps extends StyleProps, FlexChildProps, Props {
  /** Ordered tabs. */
  items: readonly TabItem[];
  /** Controlled active tab key. */
  value: string;
  /** Called with a newly activated tab key. */
  onChange?: (key: string) => void;
}

/** Tab strip without a panel. */
export function TabList(props: TabListProps): VNode {
  return h('ui:tab-list', props);
}

/** Props accepted by {@link Tabs}. */
export interface TabsProps extends TabListProps {
  /** Content of the active tab panel. */
  children?: Child;
}

/** Tab strip with caller-owned active panel content. */
export function Tabs(props: TabsProps): VNode {
  return h('ui:tabs', props);
}

/** Controlled disclosure-state helper. */
export interface Disclosure {
  /** Current open state. */
  readonly open: Signal<boolean>;
  /** Invert the current state. */
  toggle(): void;
  /** Replace the current state. */
  set(open: boolean): void;
}

/** Create toggleable state that survives component re-renders. */
export function createDisclosure(defaultOpen = false): Disclosure {
  const open = createSignal(defaultOpen);
  return {
    open,
    toggle: () => open.set(!open.get()),
    set: (next) => open.set(next),
  };
}

/** One section of an {@link Accordion}. */
export interface AccordionSection {
  /** Stable section identity. */
  key: string;
  /** Visible section title. */
  title: string;
  /** Section body. */
  content: Child;
}

/** Props accepted by {@link Accordion}. */
export interface AccordionProps extends FlexChildProps, Props {
  /** Ordered sections. */
  sections: readonly AccordionSection[];
  /** Controlled set of expanded section keys. */
  openKeys: readonly string[];
  /** Called with the section key whose state should toggle. */
  onToggle?: (key: string) => void;
  /** Expander placement forwarded to each section. */
  expander?: ExpanderPosition;
}

/** Stack of reusable {@link Details} sections. */
export function Accordion(props: AccordionProps): VNode {
  const { sections, openKeys, onToggle, expander, id, ...rest } = props;
  return h(
    Box,
    { ...rest, direction: 'column', id } as Props,
    ...sections.map((section) =>
      h(
        Details,
        {
          key: section.key,
          id: id === undefined ? undefined : `${id}:${section.key}`,
          title: section.title,
          open: openKeys.includes(section.key),
          expander,
          onToggle: onToggle === undefined ? undefined : () => onToggle(section.key),
        },
        section.content,
      ),
    ),
  );
}

/** Accordion open-key state helper. */
export interface AccordionState {
  /** Current expanded keys. */
  readonly openKeys: Signal<string[]>;
  /** Toggle one section key. */
  toggle(key: string): void;
}

/** Create accordion state; `single` closes peers when opening a section. */
export function createAccordion(single = false): AccordionState {
  const openKeys = createSignal<string[]>([]);
  return {
    openKeys,
    toggle(key): void {
      const current = openKeys.get();
      if (current.includes(key)) {
        openKeys.set(current.filter((open) => open !== key));
      } else {
        openKeys.set(single ? [key] : [...current, key]);
      }
    },
  };
}
