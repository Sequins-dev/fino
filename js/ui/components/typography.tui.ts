/**
 * Terminal lowerings for typography components.
 *
 * @internal
 */
import { h } from 'fino:ui';
import type { Props } from 'fino:ui';
import { Box, Clickable, Rule, Text } from 'fino:ui/components';
import { styles } from 'fino:ui/components/theme';
import type { Style } from 'fino:tty/style';
import { mapComponentLowering } from 'internal:ui/components/target';
import {
  Blockquote,
  Bold,
  Code,
  Heading,
  InlineCode,
  Italic,
  Link,
  List,
  headingLevel,
  highlightCode,
} from 'internal:ui/components/typography';

const CODE_STYLE: Record<'keyword' | 'string' | 'number' | 'comment' | 'regexp', Style> = {
  keyword: styles.accent,
  string: styles.success,
  number: styles.info,
  comment: styles.muted,
  regexp: styles.warning,
};

mapComponentLowering(Heading, 'tui', (props, children) => {
  const { level, style, ...rest } = props;
  const normalized = headingLevel(level);
  const semantic = [styles.bold, ...(normalized <= 2 ? [styles.accent] : [])];
  const supplied = Array.isArray(style) ? style : style === undefined ? [] : [style];
  const text = h(Text, { ...rest, style: [...supplied, ...semantic] } as Props, ...children);
  if (normalized !== 1) return text;
  return h(Box, { direction: 'column' }, text, h(Rule, { style: [styles.dim] }));
});

mapComponentLowering(Bold, 'tui', (props, children) =>
  h(Text, { ...props, bold: true } as Props, ...children),
);
mapComponentLowering(Italic, 'tui', (props, children) =>
  h(Text, { ...props, italic: true } as Props, ...children),
);

mapComponentLowering(Link, 'tui', (props, children) => {
  const { href: _href, onActivate, id, ...rest } = props;
  const text = h(Text, { style: [styles.accent, styles.underline] }, ...children);
  if (onActivate !== undefined) {
    return h(Clickable, { ...rest, id, onClick: onActivate } as Props, text);
  }
  return h(Text, { ...rest, id, style: [styles.accent, styles.underline] } as Props, ...children);
});

mapComponentLowering(Blockquote, 'tui', (props, children) => {
  const { id, ...rest } = props;
  return h(
    Box,
    { ...rest, id, direction: 'column' } as Props,
    ...children.map((child, index) =>
      h(
        Box,
        { key: String(index), direction: 'row', gap: 1 },
        h(Text, { style: [styles.dim] }, '│'),
        h(Box, { direction: 'column', grow: 1, style: [styles.dim] }, child),
      ),
    ),
  );
});

mapComponentLowering(List, 'tui', (props) => {
  const { ordered, items, id, ...rest } = props;
  const markerWidth = (ordered === true ? `${items.length}.` : '•').length;
  return h(
    Box,
    { ...rest, id, direction: 'column' } as Props,
    ...items.map((item, index) =>
      h(
        Box,
        { key: String(index), direction: 'row', gap: 1 },
        h(
          Text,
          { width: markerWidth, align: 'end', style: [styles.dim] },
          ordered === true ? `${index + 1}.` : '•',
        ),
        h(
          Box,
          { direction: 'column', grow: 1 },
          typeof item === 'string' || typeof item === 'number'
            ? h(Text, { wrap: true }, item)
            : item,
        ),
      ),
    ),
  );
});

mapComponentLowering(Code, 'tui', (props) => {
  const { code, language, showLineNumbers, filename, copyable, onCopy, id, ...rest } = props;
  const rows = highlightCode(code, language);
  const gutterWidth = String(rows.length).length;
  const header =
    filename === undefined && copyable !== true
      ? null
      : h(
          Box,
          { direction: 'column' },
          h(
            Box,
            { direction: 'row', justify: 'between' },
            h(Text, { style: [styles.dim] }, filename ?? ''),
            copyable === true
              ? h(
                  Clickable,
                  {
                    id: id === undefined ? undefined : `${id}:copy`,
                    focusable: false,
                    onClick: onCopy === undefined ? undefined : () => onCopy(code),
                  },
                  h(Text, { style: [styles.dim] }, '⧉ copy'),
                )
              : null,
          ),
          h(Rule, { style: [styles.dim] }),
        );
  return h(
    'box',
    { ...rest, id, direction: 'column', border: true, paddingX: 1 },
    header,
    ...rows.map((runs, index) =>
      h(
        Box,
        { key: String(index), direction: 'row', gap: showLineNumbers === true ? 1 : 0 },
        showLineNumbers === true
          ? h(Text, { width: gutterWidth, align: 'end', style: [styles.dim] }, String(index + 1))
          : null,
        h(
          Box,
          { direction: 'row' },
          ...runs.map((run, runIndex) =>
            h(
              Text,
              { key: String(runIndex), style: run.cls === null ? [] : [CODE_STYLE[run.cls]] },
              run.text,
            ),
          ),
        ),
      ),
    ),
  );
});

mapComponentLowering(InlineCode, 'tui', (props, children) =>
  h(Text, { ...props, dim: true, inverse: true } as Props, ...children),
);
