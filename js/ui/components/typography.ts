/**
 * internal:ui/components/typography — prose: headings, emphasis, links,
 * quotes, lists, and code.
 *
 * @internal
 */
import { h, type Child, type Props, type VNode } from 'fino:ui';
import type { FlexChildProps, StyleProps } from 'internal:ui/components/primitives';

/** Props accepted by `Heading`. */
export interface HeadingProps extends StyleProps, FlexChildProps, Props {
  /** Heading level 1-6; defaults to 1. Levels 1-2 render in the accent color. */
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  children?: Child;
}
/** Section heading. Level 1 additionally draws a rule beneath it. */
export function Heading(props: HeadingProps): VNode {
  return h('ui:heading', props);
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
export function Bold(props: BoldProps): VNode {
  return h('ui:bold', props);
}

/** Props accepted by `Italic`. */
export interface ItalicProps extends StyleProps, FlexChildProps, Props {
  children?: Child;
}
/** Italic inline emphasis. Compose it as a row sibling, not nested inside a `Text` — see `Bold`. */
export function Italic(props: ItalicProps): VNode {
  return h('ui:italic', props);
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
export function Link(props: LinkProps): VNode {
  return h('ui:link', props);
}

/** Props accepted by `Blockquote`. */
export interface BlockquoteProps extends FlexChildProps, Props {
  id?: string;
  children?: Child;
}
/** Quoted content, set off with a leading gutter rule and dimmed text. */
export function Blockquote(props: BlockquoteProps): VNode {
  return h('ui:blockquote', props);
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
export function List(props: ListProps): VNode {
  return h('ui:list', props);
}

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
export function Code(props: CodeProps): VNode {
  return h('ui:code', props);
}

/** Props accepted by `InlineCode`. */
export interface InlineCodeProps extends StyleProps, FlexChildProps, Props {
  children?: Child;
}
/** Inline code span. Compose it as a row sibling, not nested inside a `Text` — see `Bold`. */
export function InlineCode(props: InlineCodeProps): VNode {
  return h('ui:inline-code', props);
}
