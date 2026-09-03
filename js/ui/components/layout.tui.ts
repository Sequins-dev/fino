/**
 * Terminal lowerings for layout components.
 *
 * @internal
 */
import { h } from 'fino:ui';
import type { Props } from 'fino:ui';
import { Box, Text } from 'fino:ui/components';
import { styles } from 'fino:ui/components/theme';
import { Field, Fieldset, Panel } from 'internal:ui/components/layout';
import { mapComponentLowering } from 'internal:ui/components/target';

mapComponentLowering(Panel, 'tui', (props, children) => {
  const { title, ...rest } = props;
  return h(
    'box',
    { border: true, paddingX: 1, direction: 'column', ...rest, borderTitle: title },
    ...children,
  );
});

mapComponentLowering(Field, 'tui', (props, children) => {
  const { label, hint, error, required, htmlFor: _htmlFor, id, ...rest } = props;
  return h(
    Box,
    { ...rest, direction: 'column', id } as Props,
    h(
      Box,
      { direction: 'row' },
      h(Text, { style: [styles.bold] }, label),
      required === true ? h(Text, { style: [styles.danger, styles.bold] }, ' *') : null,
    ),
    ...children,
    hint === undefined ? null : h(Text, { style: [styles.dim] }, hint),
    error === undefined ? null : h(Text, { style: [styles.danger] }, error),
  );
});

mapComponentLowering(Fieldset, 'tui', (props, children) => {
  const { legend, ...rest } = props;
  return h(
    'box',
    { border: true, paddingX: 1, direction: 'column', ...rest, borderTitle: legend },
    ...children,
  );
});
