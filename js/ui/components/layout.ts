/**
 * internal:ui/components/layout — containers that group other content:
 * stacks, panels, and the form field wrappers.
 *
 * @internal
 */
import { h, type NormalizedChild, type Child, type Props, type VNode } from 'fino:ui';
import {
  borderShorthand,
  flexChildCss,
  injectFirstControlAria,
  lowerChildren,
  sizeCss,
} from 'internal:ui/components/html-runtime';
import { Box } from 'internal:ui/components/primitives';
import type { BoxProps, FlexChildProps } from 'internal:ui/components/primitives';

/** Props accepted by `Stack`, `HStack`, and `VStack`. */
export interface StackProps extends Omit<BoxProps, 'direction'> {
  children?: Child;
}
// These compose the `Box` *component* rather than emitting the `box` node
// name directly. A bare node name is a render target's own terminal
// vocabulary; going through the component is what lets each target substitute
// its own lowering, which on the web is a real `<div>` rather than a `<box>`.
/** Vertical box, `gap` between children. */
export function VStack(props: StackProps): VNode {
  return h(Box, { ...props, direction: 'column' });
}
/** Horizontal box, `gap` between children. */
export function HStack(props: StackProps): VNode {
  return h(Box, { ...props, direction: 'row' });
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
export function Panel(all: PanelProps): VNode {
  const { children = [], ...props } = all as PanelProps & { children?: NormalizedChild[] };
  const { title, id, border, borderStyle, rounded } = props;
  const css: Record<string, string> = {};
  sizeCss(props, css);
  flexChildCss(props, css);
  const styleName = typeof border === 'string' ? border : borderStyle;
  if (typeof styleName === 'string' || rounded !== undefined) {
    const spec = borderShorthand(styleName, rounded === true, 'var(--ui-border)');
    css.border = spec.border;
    css.borderRadius = spec.radius;
  }
  const attrs: Props = { className: 'ui-panel', ...idAttr(id) };
  if (Object.keys(css).length > 0) attrs.style = css;
  return h(
    'section',
    attrs,
    title !== undefined ? h('header', { className: 'ui-panel-title' }, title) : null,
    ...children,
  );
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
export function Field(all: FieldProps): VNode {
  const { children = [], ...props } = all as FieldProps & { children?: NormalizedChild[] };
  const { label, hint, error, required, htmlFor, id } = props;
  const hintId = id !== undefined ? `${id}-hint` : undefined;
  const errorId = id !== undefined ? `${id}-error` : undefined;
  const describedBy = [
    hint !== undefined ? hintId : undefined,
    error !== undefined ? errorId : undefined,
  ].filter((entry): entry is string => entry !== undefined);
  const controlAttrs: Props = {};
  if (error !== undefined) controlAttrs['aria-invalid'] = 'true';
  if (describedBy.length > 0) controlAttrs['aria-describedby'] = describedBy.join(' ');
  let kids = children;
  if (Object.keys(controlAttrs).length > 0) {
    kids = injectFirstControlAria(lowerChildren(kids), controlAttrs).nodes;
  }
  const labelText = h(
    'span',
    { className: 'ui-field-label' },
    label,
    required === true
      ? h('span', { className: 'ui-field-required', 'aria-hidden': 'true' }, ' *')
      : null,
  );
  const body = [
    ...kids,
    hint !== undefined ? h('small', { className: 'ui-field-hint', id: hintId }, hint) : null,
    error !== undefined
      ? h('small', { className: 'ui-field-error', role: 'alert', id: errorId }, error)
      : null,
  ];
  if (typeof htmlFor === 'string') {
    return h(
      'div',
      { className: 'ui-field', ...idAttr(id) },
      h('label', { className: 'ui-field-label-row', for: htmlFor }, labelText),
      ...body,
    );
  }
  return h('label', { className: 'ui-field ui-field-wrap', ...idAttr(id) }, labelText, ...body);
}

/** Props accepted by `Fieldset`. */
export interface FieldsetProps extends BoxProps {
  legend: string;
}
/** Group of fields under a legend: a bordered box with the legend in the border (terminal), a real `<fieldset><legend>` (web). */
export function Fieldset(all: FieldsetProps): VNode {
  const { children = [], ...props } = all as FieldsetProps & { children?: NormalizedChild[] };
  const { legend, id } = props;
  return h(
    'fieldset',
    { className: 'ui-fieldset', ...idAttr(id) },
    h('legend', null, legend),
    ...children,
  );
}
