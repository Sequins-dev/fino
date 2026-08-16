/**
 * internal:ui/components/typography — prose: headings, emphasis, links,
 * quotes, lists, and code.
 *
 * @internal
 */
import { h, type NormalizedChild, type Child, type Props, type VNode } from 'fino:ui';
import {
  actionForm,
  actionsActive,
  handlerOf,
  idAttr,
  inlineStyleAttrs,
  num,
  register,
  safeHref,
} from 'internal:ui/components/html-runtime';
import { highlightLines } from 'fino:format/typescript';
import type { FlexChildProps, StyleProps } from 'internal:ui/components/primitives';

/** Props accepted by `Heading`. */
export interface HeadingProps extends StyleProps, FlexChildProps, Props {
  /** Heading level 1-6; defaults to 1. Levels 1-2 render in the accent color. */
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  children?: Child;
}
/** Section heading. Level 1 additionally draws a rule beneath it. */
export function Heading(all: HeadingProps): VNode {
  const { children = [], ...props } = all as HeadingProps & { children?: NormalizedChild[] };
  const { level, id } = props;
  const lvl = Math.min(6, Math.max(1, Math.floor((level as number | undefined) ?? 1)));
  return h(
    `h${lvl}`,
    { className: `ui-heading ui-heading-${lvl}`, ...idAttr(id) },
    ...children,
  );
}

/** Props accepted by `Bold`. */
export interface BoldProps extends StyleProps, FlexChildProps, Props {
  children?: Child;
}
/**
 * Bold inline emphasis. Compose it as a row sibling of surrounding `Text`
 * (e.g. inside an `HStack`) rather than nesting it inside a `Text` — the
 * terminal's `Text` flattens descendant nodes to one plain styled run, so
 * styling on a `Bold` nested inside it is silently dropped there (see the
 * module guide's Typography section).
 */
export function Bold(all: BoldProps): VNode {
  const { children = [], ...props } = all as BoldProps & { children?: NormalizedChild[] };
  const { id, ...rest } = props;
  return h('strong', inlineStyleAttrs(rest as Props, id), ...children);
}

/** Props accepted by `Italic`. */
export interface ItalicProps extends StyleProps, FlexChildProps, Props {
  children?: Child;
}
/** Italic inline emphasis. Compose it as a row sibling, not nested inside a `Text` — see `Bold`. */
export function Italic(all: ItalicProps): VNode {
  const { children = [], ...props } = all as ItalicProps & { children?: NormalizedChild[] };
  const { id, ...rest } = props;
  return h('em', inlineStyleAttrs(rest as Props, id), ...children);
}

/** Props accepted by `Link`. */
export interface LinkProps extends FlexChildProps, Props {
  /**
   * Navigation target. On the web this becomes a real `<a href>` — `Link` is
   * the one catalog component allowed to navigate — once the HTML target's
   * `safeHref` scheme allowlist (`http(s):`, `mailto:`, `tel:`, and relative
   * forms) accepts it; anything else, e.g. `javascript:`, renders as text
   * with no `href` attribute rather than a live anchor. In the terminal it is
   * rendered as styled, underlined text (see the module guide for why OSC 8
   * terminal hyperlinks aren't used).
   */
  href?: string;
  /** In-app activation. Wins over `href` when both are given. */
  onActivate?: () => void;
  id?: string;
  children?: Child;
}
/**
 * Link: navigational with `href`, an in-app activator with `onActivate`, or
 * both — see `href` and `onActivate` for how they combine. Compose it as a
 * row sibling, not nested inside a `Text` — see `Bold`.
 */
export function Link(all: LinkProps): VNode {
  const { children = [], ...props } = all as LinkProps & { children?: NormalizedChild[] };
  const { href, onActivate, id } = props;
  const activate = handlerOf<() => void>(onActivate);
  const kids = children;
  const safe = safeHref(href);
  const hasHref = safe !== undefined;
  if (activate !== undefined) {
    if (actionsActive()) {
      const act = register(() => activate());
      if (hasHref) {
        return actionForm(
          { act },
          h(
            'a',
            {
              className: 'ui-link',
              href: safe,
              onclick: 'event.preventDefault();this.form.requestSubmit();',
              ...idAttr(id),
            },
            ...kids,
          ),
        );
      }
      return actionForm(
        {},
        h('button', { className: 'ui-link', name: 'do', value: act, ...idAttr(id) }, ...kids),
      );
    }
    return hasHref
      ? h('a', { className: 'ui-link', href: safe, ...idAttr(id) }, ...kids)
      : h('button', { className: 'ui-link', type: 'button', ...idAttr(id) }, ...kids);
  }
  if (hasHref) return h('a', { className: 'ui-link', href: safe, ...idAttr(id) }, ...kids);
  return h('span', { className: 'ui-link', ...idAttr(id) }, ...kids);
}

/** Props accepted by `Blockquote`. */
export interface BlockquoteProps extends FlexChildProps, Props {
  id?: string;
  children?: Child;
}
/** Quoted content, set off with a leading gutter rule and dimmed text. */
export function Blockquote(all: BlockquoteProps): VNode {
  const { children = [], ...props } = all as BlockquoteProps & { children?: NormalizedChild[] };
  const { id } = props;
  return h(
    'blockquote',
    { className: 'ui-blockquote', ...idAttr(id) },
    ...children,
  );
}

/** Props accepted by `List`. */
export interface ListProps extends FlexChildProps, Props {
  /** Numbered markers instead of bullets. */
  ordered?: boolean;
  /** Item content, one entry per row; entries may be strings or nested VNodes. */
  items: Child[];
  id?: string;
}
/** Bulleted or numbered list, with a hanging indent for wrapped item lines. */
export function List(all: ListProps): VNode {
  const { children = [], ...props } = all as ListProps & { children?: NormalizedChild[] };
  const { ordered, items, id } = props;
  const tag = ordered === true ? 'ol' : 'ul';
  return h(
    tag,
    { className: 'ui-list', ...idAttr(id) },
    ...items.map((item, index) => h('li', { key: String(index) }, item)),
  );
}

const CODE_TOK: Record<'keyword' | 'string' | 'number' | 'comment' | 'regexp', string> = {
  keyword: 'tok-keyword',
  string: 'tok-string',
  number: 'tok-number',
  comment: 'tok-comment',
  regexp: 'tok-regexp',
};

/** Props accepted by `Code`. */
export interface CodeProps extends FlexChildProps, Props {
  code: string;
  /** Highlighting language; unrecognized or omitted languages render plain. */
  language?: string;
  showLineNumbers?: boolean;
  /** Shown in a header bar above the code; also gives `copyable` a home when there is no filename. */
  filename?: string;
  /**
   * Show a copy-to-clipboard affordance. On the web it copies client-side
   * (a server round trip cannot write the clipboard); in the terminal it
   * calls `onCopy` — the lowering only emits nodes, it cannot itself write to
   * the terminal — so pass `onCopy` (e.g. `fino:tty/tui`'s
   * `copyToClipboard`) for the affordance to do anything there.
   */
  copyable?: boolean;
  onCopy?: (code: string) => void;
  id?: string;
}
/**
 * Syntax-highlighted code block. Highlighting reuses the OXC-backed tokens
 * from `fino:format/typescript` for JS/TS/JSX family languages; anything
 * else renders as plain monospace text.
 */
export function Code(all: CodeProps): VNode {
  const { children = [], ...props } = all as CodeProps & { children?: NormalizedChild[] };
  const {
    code: source,
    language,
    showLineNumbers,
    filename,
    copyable,
    id,
  } = props;
  const lines = highlightLines(source, language);
  const codeClass =
    typeof language === 'string' && language.length > 0 ? `language-${language}` : undefined;
  const body = lines.map((runs, index) =>
    h(
      'span',
      { className: 'ui-code-line' },
      showLineNumbers === true ? h('span', { className: 'ui-code-num' }, String(index + 1)) : null,
      h(
        'span',
        { className: 'ui-code-content' },
        ...runs.map((run) =>
          run.cls ? h('span', { className: CODE_TOK[run.cls] }, run.text) : run.text,
        ),
      ),
    ),
  );
  const pre = h(
    'pre',
    null,
    h('code', codeClass !== undefined ? { className: codeClass } : null, ...body),
  );
  // The copy button reads its sibling <code>'s textContent client-side
  // (internal:ui/web/client's `[data-fi-copy]` listener) rather than
  // duplicating the (potentially large) source into a data-* attribute.
  const copyButton =
    copyable === true
      ? h(
          'button',
          {
            type: 'button',
            className: 'ui-copy',
            'aria-label': 'Copy code',
            'data-fi-copy': '1',
          },
          'Copy',
        )
      : null;
  // The bar exists only to carry a filename. Without one the copy button
  // overlays the code area instead, so an unnamed block keeps its full height.
  const bar =
    filename !== undefined
      ? h(
          'figcaption',
          { className: 'ui-code-bar' },
          h('span', { className: 'ui-code-filename' }, filename),
          copyButton,
        )
      : null;
  return h(
    'figure',
    { className: 'ui-code', ...idAttr(id) },
    bar,
    bar === null ? copyButton : null,
    pre,
  );
}

/** Props accepted by `InlineCode`. */
export interface InlineCodeProps extends StyleProps, FlexChildProps, Props {
  children?: Child;
}
/** Inline code span. Compose it as a row sibling, not nested inside a `Text` — see `Bold`. */
export function InlineCode(all: InlineCodeProps): VNode {
  const { children = [], ...props } = all as InlineCodeProps & { children?: NormalizedChild[] };
  const { id, ...rest } = props;
  const attrs = inlineStyleAttrs(rest as Props, id);
  attrs.className = 'ui-inline-code';
  return h('code', attrs, ...children);
}
