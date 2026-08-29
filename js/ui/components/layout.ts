/**
 * Layout component definitions shared by every render target.
 *
 * @internal
 */
import { h } from 'fino:ui';
import type { Child, Props, VNode } from 'fino:ui';
import { Box } from 'fino:ui/components';
import type { BoxProps, FlexChildProps } from 'fino:ui/components';

/** Props accepted by {@link Stack}, {@link HStack}, and {@link VStack}. */
export interface StackProps extends Omit<BoxProps, 'direction'> {
  /** Ordered stack content. */
  children?: Child;
}

/** Vertical stack composed from the shared {@link Box} primitive. */
export function VStack(props: StackProps): VNode {
  return h(Box, { ...props, direction: 'column' });
}

/** Horizontal stack composed from the shared {@link Box} primitive. */
export function HStack(props: StackProps): VNode {
  return h(Box, { ...props, direction: 'row' });
}

/** Alias for the default vertical stack. */
export function Stack(props: StackProps): VNode {
  return VStack(props);
}

/** Props accepted by {@link Panel}. */
export interface PanelProps extends BoxProps {
  /** Optional heading associated with the content region. */
  title?: string;
}

/** Titled content region rendered as a card or terminal panel. */
export function Panel(props: PanelProps): VNode {
  return h('ui:panel', props);
}

/** Props accepted by {@link Field}. */
export interface FieldProps extends FlexChildProps, Props {
  /** Visible label for the field control. */
  label: string;
  /** Supplemental guidance shown beneath the control. */
  hint?: string;
  /** Validation error shown beneath the control. */
  error?: string;
  /** Whether the label displays a required marker. */
  required?: boolean;
  /** HTML control id targeted by the label instead of wrapping the control. */
  htmlFor?: string;
  /** Stable wrapper id used to derive hint and error ids. */
  id?: string;
  /** Field control and related content. */
  children?: Child;
}

/** Label, control, hint, and error composition shared across targets. */
export function Field(props: FieldProps): VNode {
  return h('ui:field', props);
}

/** Props accepted by {@link Fieldset}. */
export interface FieldsetProps extends BoxProps {
  /** Caption describing the grouped fields. */
  legend: string;
}

/** Related field group with a visible legend. */
export function Fieldset(props: FieldsetProps): VNode {
  return h('ui:fieldset', props);
}
