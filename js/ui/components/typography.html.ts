/**
 * HTML lowerings and styles for typography components.
 *
 * @internal
 */
import { h } from 'fino:ui';
import type { Props } from 'fino:ui';
import {
  actionForm,
  actionsActive,
  componentStyleAttrs,
  registerAction,
  safeHref,
} from 'internal:ui/components/html-runtime';
import { mapComponentLowering, registerHtmlCss } from 'internal:ui/components/target';
import {
  Blockquote,
  Bold,
  Caption,
  Code,
  Heading,
  InlineCode,
  Italic,
  Lead,
  Link,
  List,
  headingLevel,
  highlightCode,
} from 'internal:ui/components/typography';

const CODE_CLASS = {
  keyword: 'tok-keyword',
  string: 'tok-string',
  number: 'tok-number',
  comment: 'tok-comment',
  regexp: 'tok-regexp',
} as const;

mapComponentLowering(Heading, 'html', (props, children) => {
  const level = headingLevel(props.level);
  return h(
    `h${level}`,
    componentStyleAttrs(props as Props, `ui-heading ui-heading-${level}`),
    ...children,
  );
});

mapComponentLowering(Lead, 'html', (props, children) =>
  h('p', componentStyleAttrs(props as Props, 'ui-lead'), ...children),
);

mapComponentLowering(Caption, 'html', (props, children) =>
  h('small', componentStyleAttrs(props as Props, 'ui-caption'), ...children),
);

mapComponentLowering(Bold, 'html', (props, children) =>
  h('strong', componentStyleAttrs(props as Props), ...children),
);
mapComponentLowering(Italic, 'html', (props, children) =>
  h('em', componentStyleAttrs(props as Props), ...children),
);

mapComponentLowering(Link, 'html', (props, children) => {
  const href = safeHref(props.href);
  const activate = typeof props.onActivate === 'function' ? props.onActivate : undefined;
  const attrs = componentStyleAttrs(props as Props, 'ui-link');
  if (activate === undefined) {
    if (href !== undefined) return h('a', { ...attrs, href }, ...children);
    return h('span', attrs, ...children);
  }
  if (!actionsActive()) {
    if (href !== undefined) return h('a', { ...attrs, href }, ...children);
    return h('button', { ...attrs, type: 'button' }, ...children);
  }
  const act = registerAction(() => activate());
  if (href !== undefined) {
    return actionForm(
      { act },
      h(
        'a',
        { ...attrs, href, onclick: 'event.preventDefault();this.form.requestSubmit();' },
        ...children,
      ),
    );
  }
  return actionForm({}, h('button', { ...attrs, name: 'do', value: act }, ...children));
});

mapComponentLowering(Blockquote, 'html', (props, children) =>
  h('blockquote', componentStyleAttrs(props as Props, 'ui-blockquote'), ...children),
);

mapComponentLowering(List, 'html', (props) => {
  const { ordered, items } = props;
  const tag = ordered === true ? 'ol' : 'ul';
  return h(
    tag,
    componentStyleAttrs(props as Props, 'ui-list'),
    ...items.map((item, index) => h('li', { key: String(index) }, item)),
  );
});

mapComponentLowering(Code, 'html', (props) => {
  const { code, language, showLineNumbers, filename, copyable } = props;
  const rows = highlightCode(code, language);
  const body = rows.map((runs, index) =>
    h(
      'span',
      { className: 'ui-code-line' },
      showLineNumbers === true ? h('span', { className: 'ui-code-num' }, String(index + 1)) : null,
      h(
        'span',
        { className: 'ui-code-content' },
        ...runs.map((run) =>
          run.cls === null ? run.text : h('span', { className: CODE_CLASS[run.cls] }, run.text),
        ),
      ),
    ),
  );
  const codeAttrs: Props = {};
  if (language !== undefined && language.length > 0) codeAttrs.className = `language-${language}`;
  const copy =
    copyable === true
      ? h(
          'button',
          { type: 'button', className: 'ui-copy', 'aria-label': 'Copy code', 'data-fi-copy': '1' },
          'Copy',
        )
      : null;
  const bar =
    filename === undefined
      ? null
      : h(
          'figcaption',
          { className: 'ui-code-bar' },
          h('span', { className: 'ui-code-filename' }, filename),
          copy,
        );
  return h(
    'figure',
    componentStyleAttrs(props as Props, 'ui-code'),
    bar,
    bar === null ? copy : null,
    h('pre', null, h('code', codeAttrs, ...body)),
  );
});

mapComponentLowering(InlineCode, 'html', (props, children) =>
  h('code', componentStyleAttrs(props as Props, 'ui-inline-code'), ...children),
);

registerHtmlCss(`
.ui-heading { font-weight: 700; line-height: 1.3; margin: 1.25rem 0 0.5rem; }
.ui-heading:first-child { margin-top: 0; }
.ui-heading-1 { font-size: 1.75rem; padding-bottom: 0.4rem; border-bottom: 1px solid var(--ui-border); }
.ui-heading-2 { font-size: 1.4rem; }
.ui-heading-3 { font-size: 1.15rem; }
.ui-heading-4 { font-size: 1rem; }
.ui-heading-5, .ui-heading-6 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }
.ui-lead { margin: 0.5rem 0; font-size: 1.35em; line-height: 1.3; }
.ui-caption { display: block; color: var(--tui-bright-black); font-size: 0.85em; line-height: 1.4; }
.ui-link { color: var(--ui-accent); cursor: pointer; }
.ui-link:hover { text-decoration: underline; }
button.ui-link { background: none; border: none; padding: 0; font: inherit; }
.ui-blockquote { margin: 0.5rem 0; padding: 0.25rem 0 0.25rem 0.875rem; border-left: 3px solid var(--ui-border); }
.ui-list { margin: 0.5rem 0; padding-left: 1.5rem; display: flex; flex-direction: column; gap: 0.25rem; }
.ui-code { margin: 0.5rem 0; position: relative; }
.ui-code pre { margin: 0; border: 1px solid var(--ui-border); border-radius: 0.5rem; padding: 0.75rem 1rem; overflow-x: auto; }
.ui-code code, .ui-inline-code { font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace; }
.ui-code-line { display: flex; gap: 1rem; }
.ui-code-num { flex: none; width: 2.25rem; text-align: right; color: var(--tui-bright-black); user-select: none; }
.ui-code-content { white-space: pre; }
.ui-inline-code { border: 1px solid var(--ui-border); border-radius: 0.25rem; padding: 0.05rem 0.35rem; }
.tok-keyword { color: var(--tui-cyan); } .tok-string { color: var(--tui-green); }
.tok-number { color: var(--tui-blue); } .tok-comment { color: var(--tui-bright-black); }
.tok-regexp { color: var(--tui-yellow); }
.ui-code-bar { display: flex; justify-content: space-between; padding: 0.375rem 0.75rem; border: 1px solid var(--ui-border); border-bottom: none; }
.ui-code-bar + pre { border-top-left-radius: 0; border-top-right-radius: 0; }
.ui-copy { opacity: 0; cursor: pointer; }
.ui-code > .ui-copy { position: absolute; top: 0.375rem; right: 0.375rem; }
.ui-code:hover .ui-copy, .ui-code:focus-within .ui-copy, .ui-copy:focus-visible { opacity: 1; }
`);
