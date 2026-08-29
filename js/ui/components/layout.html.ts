/**
 * HTML lowerings and styles for layout components.
 *
 * @internal
 */
import { h } from 'fino:ui';
import type { NormalizedChild, Props, VNode } from 'fino:ui';
import { Input } from 'fino:ui/components';
import { componentStyleAttrs, idAttr, sizeCss } from 'internal:ui/components/html-runtime';
import { Field, Fieldset, Panel } from 'internal:ui/components/layout';
import type { FieldProps, FieldsetProps, PanelProps } from 'internal:ui/components/layout';
import { mapComponentLowering, registerHtmlCss } from 'internal:ui/components/target';

function decorateFirstControl(
  children: NormalizedChild[],
  attrs: Props,
): { children: NormalizedChild[]; found: boolean } {
  let found = false;
  const next = children.map((child) => {
    if (found || typeof child === 'string') return child;
    if (
      child.type === Input ||
      child.type === 'input' ||
      child.type === 'select' ||
      child.type === 'textarea' ||
      child.type === 'button'
    ) {
      found = true;
      return { ...child, props: { ...child.props, ...attrs } };
    }
    const nested = decorateFirstControl([...child.children], attrs);
    if (!nested.found) return child;
    found = true;
    return { ...child, children: nested.children };
  });
  return { children: next, found };
}

mapComponentLowering(Panel, 'html', (props, children) => {
  const { title, ...rest } = props as Omit<PanelProps, 'children'>;
  const attrs = componentStyleAttrs(rest as Props, 'ui-panel');
  const css = (attrs.style ?? {}) as Record<string, string>;
  sizeCss(rest as Props, css);
  if (Object.keys(css).length > 0) attrs.style = css;
  return h(
    'section',
    attrs,
    title === undefined ? null : h('header', { className: 'ui-panel-title' }, title),
    ...children,
  );
});

mapComponentLowering(Field, 'html', (props, children) => {
  const { label, hint, error, required, htmlFor, id, ...rest } = props as Omit<
    FieldProps,
    'children'
  >;
  const hintId = id === undefined || hint === undefined ? undefined : `${id}-hint`;
  const errorId = id === undefined || error === undefined ? undefined : `${id}-error`;
  const describedBy = [hintId, errorId].filter((value): value is string => value !== undefined);
  const controlAttrs: Props = {};
  if (error !== undefined) controlAttrs['aria-invalid'] = 'true';
  if (describedBy.length > 0) controlAttrs['aria-describedby'] = describedBy.join(' ');
  const decorated = decorateFirstControl(children, controlAttrs).children;
  const wrapper = componentStyleAttrs(rest as Props, 'ui-field');
  Object.assign(wrapper, idAttr(id));
  const labelText = h(
    'span',
    { className: 'ui-field-label' },
    label,
    required === true
      ? h('span', { className: 'ui-field-required', 'aria-hidden': 'true' }, ' *')
      : null,
  );
  const body = [
    ...decorated,
    hint === undefined ? null : h('small', { className: 'ui-field-hint', id: hintId }, hint),
    error === undefined
      ? null
      : h('small', { className: 'ui-field-error', role: 'alert', id: errorId }, error),
  ];
  if (htmlFor !== undefined) {
    return h(
      'div',
      wrapper,
      h('label', { className: 'ui-field-label-row', for: htmlFor }, labelText),
      ...body,
    );
  }
  wrapper.className = 'ui-field ui-field-wrap';
  return h('label', wrapper, labelText, ...body);
});

mapComponentLowering(Fieldset, 'html', (props, children) => {
  const { legend, id, ...rest } = props as Omit<FieldsetProps, 'children'>;
  return h(
    'fieldset',
    componentStyleAttrs({ ...rest, id } as Props, 'ui-fieldset'),
    h('legend', null, legend),
    ...children,
  );
});

registerHtmlCss(`
.ui-panel {
  display: flex; flex-direction: column; gap: 0.5rem;
  background: var(--ui-surface); border: 1px solid var(--ui-border);
  border-radius: 0.5rem; padding: 0.875rem 1rem;
}
.ui-panel-title {
  font-size: 0.75rem; font-weight: 600; letter-spacing: 0.06em;
  text-transform: uppercase; color: var(--tui-bright-black);
}
.ui-field { display: flex; flex-direction: column; gap: 0.25rem; width: fit-content; }
.ui-field-wrap { cursor: pointer; }
.ui-field-label { font-weight: 600; font-size: 0.85rem; }
.ui-field-required, .ui-field-error { color: var(--tui-red); }
.ui-field-hint, .ui-field-error { font-size: 0.8rem; }
.ui-field-hint { color: var(--tui-bright-black); }
.ui-fieldset {
  border: 1px solid var(--ui-border); border-radius: 0.5rem;
  padding: 0.75rem 1rem; display: flex; flex-direction: column; gap: 0.625rem;
}
.ui-fieldset > legend { padding: 0 0.5ch; color: var(--tui-bright-black); font-weight: 600; }
`);
