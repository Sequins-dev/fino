/**
 * Typography component definitions and target-neutral behavior.
 *
 * @internal
 */
import { h } from 'fino:ui';
import type { Child, Props, VNode } from 'fino:ui';
import { highlightLines } from 'fino:format/typescript';
import type { FlexChildProps, StyleProps } from 'fino:ui/components';

/** Clamp an arbitrary heading level to the supported 1–6 range. */
export function headingLevel(level: unknown): 1 | 2 | 3 | 4 | 5 | 6 {
  const value = typeof level === 'number' && Number.isFinite(level) ? Math.floor(level) : 1;
  return Math.min(6, Math.max(1, value)) as 1 | 2 | 3 | 4 | 5 | 6;
}

/** Highlight source with the shared TypeScript-family token service. */
export function highlightCode(source: string, language?: string) {
  return highlightLines(source, language);
}

/** Props accepted by {@link Heading}. */
export interface HeadingProps extends StyleProps, FlexChildProps, Props {
  /** Heading level from 1 through 6; defaults to 1. */
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  /** Heading content. */
  children?: Child;
}

/** Section heading with target-appropriate hierarchy and emphasis. */
export function Heading(props: HeadingProps): VNode {
  return h('ui:heading', props);
}

/** Props accepted by {@link Lead}. */
export interface LeadProps extends StyleProps, FlexChildProps, Props {
  /** Introductory copy that establishes the main idea of a region. */
  children?: Child;
}

/** Prominent introductory prose below a title or section heading. */
export function Lead(props: LeadProps): VNode {
  return h('ui:lead', props);
}

/** Props accepted by {@link Caption}. */
export interface CaptionProps extends StyleProps, FlexChildProps, Props {
  /** Supplemental explanation for the preceding content. */
  children?: Child;
}

/** Muted supplemental copy associated with nearby content. */
export function Caption(props: CaptionProps): VNode {
  return h('ui:caption', props);
}

/** Props accepted by {@link Bold}. */
export interface BoldProps extends StyleProps, FlexChildProps, Props {
  /** Emphasized content. */
  children?: Child;
}

/** Strong inline emphasis. */
export function Bold(props: BoldProps): VNode {
  return h('ui:bold', props);
}

/** Props accepted by {@link Italic}. */
export interface ItalicProps extends StyleProps, FlexChildProps, Props {
  /** Emphasized content. */
  children?: Child;
}

/** Italic inline emphasis. */
export function Italic(props: ItalicProps): VNode {
  return h('ui:italic', props);
}

/** Props accepted by {@link Link}. */
export interface LinkProps extends FlexChildProps, Props {
  /** Safe HTTP, mail, telephone, or relative navigation target. */
  href?: string;
  /** In-application activation handler, taking precedence over navigation. */
  onActivate?: () => void;
  /** Stable target id. */
  id?: string;
  /** Link content. */
  children?: Child;
}

/** Navigation or in-application activation link. */
export function Link(props: LinkProps): VNode {
  return h('ui:link', props);
}

/** Props accepted by {@link Blockquote}. */
export interface BlockquoteProps extends FlexChildProps, Props {
  /** Stable target id. */
  id?: string;
  /** Quoted content. */
  children?: Child;
}

/** Quoted content with a target-appropriate gutter. */
export function Blockquote(props: BlockquoteProps): VNode {
  return h('ui:blockquote', props);
}

/** Props accepted by {@link List}. */
export interface ListProps extends FlexChildProps, Props {
  /** Whether markers are ordinal numbers instead of bullets. */
  ordered?: boolean;
  /** Item content rendered in source order. */
  items: Child[];
  /** Stable target id. */
  id?: string;
}

/** Bulleted or numbered prose list. */
export function List(props: ListProps): VNode {
  return h('ui:list', props);
}

/** Props accepted by {@link Code}. */
export interface CodeProps extends FlexChildProps, Props {
  /** Source text. */
  code: string;
  /** Highlighting language; unknown languages render as plain text. */
  language?: string;
  /** Whether to render a line-number gutter. */
  showLineNumbers?: boolean;
  /** Optional filename shown above the source. */
  filename?: string;
  /** Whether to show a copy affordance. */
  copyable?: boolean;
  /** Terminal copy callback receiving the unmodified source. */
  onCopy?: (code: string) => void;
  /** Stable target id. */
  id?: string;
}

/** Syntax-highlighted code block using the shared TypeScript token service. */
export function Code(props: CodeProps): VNode {
  return h('ui:code', props);
}

/** Props accepted by {@link InlineCode}. */
export interface InlineCodeProps extends StyleProps, FlexChildProps, Props {
  /** Inline source content. */
  children?: Child;
}

/** Inline monospace code. */
export function InlineCode(props: InlineCodeProps): VNode {
  return h('ui:inline-code', props);
}
