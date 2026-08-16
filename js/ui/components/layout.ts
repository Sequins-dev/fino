/**
 * internal:ui/components/layout — containers that group other content:
 * stacks, panels, and the form field wrappers.
 *
 * @internal
 */
import { h, type Child, type Props, type VNode } from 'fino:ui';
import type { BoxProps, FlexChildProps } from 'internal:ui/components/primitives';

/** Props accepted by `Stack`, `HStack`, and `VStack`. */
export interface StackProps extends Omit<BoxProps, 'direction'> {
  children?: Child;
}
/** Vertical box, `gap` between children. */
export function VStack(props: StackProps): VNode {
  return h('box', { ...props, direction: 'column' });
}
/** Horizontal box, `gap` between children. */
export function HStack(props: StackProps): VNode {
  return h('box', { ...props, direction: 'row' });
}
/** Alias of `VStack`, matching the common stacking default. */
export function Stack(props: StackProps): VNode {
  return VStack(props);
}

/** Props accepted by `Panel`. */
export interface PanelProps extends BoxProps {
  /** Panel heading. */
  title?: string;
}
/** Titled content region: a bordered box in the terminal, a card on the web. */
export function Panel(props: PanelProps): VNode {
  return h('ui:panel', props);
}

/** Props accepted by `Field`. */
export interface FieldProps extends FlexChildProps, Props {
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  /** DOM id of the control this field labels; becomes the web `<label for>`. Unused in the terminal. */
  htmlFor?: string;
  /** Hit-region id for the field's own wrapper, distinct from `htmlFor`. */
  id?: string;
  children?: Child;
}
/**
 * Form field wrapper: a label (with a `required` marker) above the control,
 * an optional dim hint, and an optional error line. In the terminal these
 * stack as plain rows; on the web the label wraps the control natively
 * (associating it with no explicit `for` needed) unless `htmlFor` names the
 * control's id explicitly, and `error` wires `role="alert"` plus
 * `aria-invalid`/`aria-describedby` onto the first native form control found
 * among `children`.
 */
export function Field(props: FieldProps): VNode {
  return h('ui:field', props);
}

/** Props accepted by `Fieldset`. */
export interface FieldsetProps extends BoxProps {
  legend: string;
}
/** Group of fields under a legend: a bordered box with the legend in the border (terminal), a real `<fieldset><legend>` (web). */
export function Fieldset(props: FieldsetProps): VNode {
  return h('ui:fieldset', props);
}
