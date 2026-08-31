/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/typography.tui — terminal forms for prose and code.
 *
 * @internal
 */
import { mapRenderTargetLowering } from 'fino:ui';
import type { NormalizedChild, VNode } from 'fino:ui';
import { Box, Clickable, Rule, Text } from 'internal:ui/components/primitives';
import { styles } from 'fino:ui/components/theme';
import { highlightLines } from 'fino:format/typescript';
import {
  Blockquote,
  Bold,
  Code,
  Heading,
  InlineCode,
  Italic,
  Link,
  List,
} from 'internal:ui/components/typography';
import type {
  BlockquoteProps,
  BoldProps,
  CodeProps,
  HeadingProps,
  InlineCodeProps,
  ItalicProps,
  LinkProps,
  ListProps,
} from 'internal:ui/components/typography';

const CODE_TONE = {
  keyword: styles.accent,
  string: styles.success,
  number: styles.info,
  comment: styles.muted,
  regexp: styles.warning,
} as const;

const TREND_GLYPH: Record<Trend, string> = { up: '▲', down: '▼', flat: '–' };
const TREND_TONE: Record<Trend, Style> = {
  up: styles.success,
  down: styles.danger,
  flat: styles.muted,
};

mapRenderTargetLowering(Heading, 'tui', (all: HeadingProps): VNode => {
  const { children = [], ...props } = all as HeadingProps & { children?: NormalizedChild[] };
  const { level, id, ...rest } = props;
  const lvl = Math.min(6, Math.max(1, Math.floor(level ?? 1)));
  const style = [styles.bold, ...(lvl <= 2 ? [styles.accent] : [])];
  const text = (
    <Text id={id} style={style} {...rest}>
      {children}
    </Text>
  );
  if (lvl !== 1) return text;
  return (
    <Box direction="column">
      {text}
      <Rule style={[styles.dim]} />
    </Box>
  );
});

mapRenderTargetLowering(Bold, 'tui', (all: BoldProps): VNode => {
  const { children = [], ...props } = all as BoldProps & { children?: NormalizedChild[] };
  const { id, ...rest } = props;
  return (
    <Text id={id} {...rest} bold>
      {children}
    </Text>
  );
});

mapRenderTargetLowering(Italic, 'tui', (all: ItalicProps): VNode => {
  const { children = [], ...props } = all as ItalicProps & { children?: NormalizedChild[] };
  const { id, ...rest } = props;
  return (
    <Text id={id} {...rest} italic>
      {children}
    </Text>
  );
});

// `Link` is the one catalog component allowed to navigate. With `onActivate`
// it becomes a focusable Clickable, same as any other click-like control.
// Terminals get no clickable hyperlinks: OSC 8 cannot survive the frame
// pipeline (parseAnsi drops non-SGR escapes so segments stay free of control
// codes), and carrying links through Segment/Row is a frame-model change we
// chose not to make. An href-only link renders as styled, underlined text.
mapRenderTargetLowering(Link, 'tui', (all: LinkProps): VNode => {
  const { children = [], ...props } = all as LinkProps & { children?: NormalizedChild[] };
  const { href: _href, onActivate, id, ...rest } = props;
  const style = [styles.accent, styles.underline];
  if (onActivate !== undefined) {
    return (
      <Clickable id={id} onClick={onActivate} {...rest}>
        <Text style={style}>{children}</Text>
      </Clickable>
    );
  }
  return (
    <Text id={id} style={style} {...rest}>
      {children}
    </Text>
  );
});

// Each child gets its own gutter row, so a quote built from several `Text`
// lines carries `│` beside every one of them — matching Markdown's `>` on
// every quoted line. A single child that word-wraps internally still only
// carries one gutter for that block: how many rows it wraps to is a
// layout-time decision made after this composer runs, and repeating the
// gutter per wrapped row would mean teaching the frame/cell layer about a
// tiling left border, which is out of scope for a component lowering.
mapRenderTargetLowering(Blockquote, 'tui', (all: BlockquoteProps): VNode => {
  const { children = [], ...props } = all as BlockquoteProps & { children?: NormalizedChild[] };
  const { id, ...rest } = props;
  return (
    <Box direction="column" id={id} {...rest}>
      {children.map((child, index) => (
        <Box key={String(index)} direction="row" gap={1}>
          <Text style={[styles.dim]}>│</Text>
          <Box direction="column" grow={1} style={[styles.dim]}>
            {child}
          </Box>
        </Box>
      ))}
    </Box>
  );
});

mapRenderTargetLowering(List, 'tui', (all: ListProps): VNode => {
  const { children = [], ...props } = all as ListProps & { children?: NormalizedChild[] };
  const { ordered, items, id, ...rest } = props;
  const width = (ordered ? `${items.length}.` : '•').length;
  return (
    <Box direction="column" id={id} {...rest}>
      {items.map((item, index) => (
        <Box key={String(index)} direction="row" gap={1}>
          <Text width={width} align="end" style={[styles.dim]}>
            {ordered ? `${index + 1}.` : '•'}
          </Text>
          <Box direction="column" grow={1}>
            {typeof item === 'string' || typeof item === 'number' ? <Text wrap>{item}</Text> : item}
          </Box>
        </Box>
      ))}
    </Box>
  );
});

mapRenderTargetLowering(Code, 'tui', (all: CodeProps): VNode => {
  const { children = [], ...props } = all as CodeProps & { children?: NormalizedChild[] };
  const {
    code: source,
    language,
    showLineNumbers,
    filename,
    copyable,
    onCopy,
    id,
    ...rest
  } = props;
  const rows = highlightLines(source, language);
  const gutterWidth = String(rows.length).length;
  const bar =
    filename !== undefined || copyable === true ? (
      <Box direction="column">
        <Box direction="row" justify="between">
          <Text style={[styles.dim]}>{filename ?? ''}</Text>
          {copyable === true ? (
            <Clickable
              id={id !== undefined ? `${id}:copy` : undefined}
              focusable={false}
              onClick={onCopy ? () => onCopy(source) : undefined}
            >
              <Text style={[styles.dim]}>⧉ copy</Text>
            </Clickable>
          ) : null}
        </Box>
        <Rule style={[styles.dim]} />
      </Box>
    ) : null;
  return (
    <Box direction="column" border paddingX={1} id={id} {...rest}>
      {bar}
      {rows.map((runs, index) => (
        <Box key={String(index)} direction="row" gap={showLineNumbers ? 1 : 0} minHeight={1}>
          {showLineNumbers ? (
            <Text width={gutterWidth} align="end" style={[styles.dim]}>
              {String(index + 1)}
            </Text>
          ) : null}
          <Box direction="row">
            {runs.map((run, runIndex) => (
              <Text key={String(runIndex)} style={run.cls ? [CODE_TONE[run.cls]] : []}>
                {run.text}
              </Text>
            ))}
          </Box>
        </Box>
      ))}
    </Box>
  );
});

mapRenderTargetLowering(InlineCode, 'tui', (all: InlineCodeProps): VNode => {
  const { children = [], ...props } = all as InlineCodeProps & { children?: NormalizedChild[] };
  const { id, ...rest } = props;
  return (
    <Text id={id} {...rest} style={[styles.dim, styles.inverse]}>
      {children}
    </Text>
  );
});
