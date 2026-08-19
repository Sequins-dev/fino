/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/layout.tui — terminal forms for panels and form field wrappers.
 *
 * @internal
 */
import { h, mapRenderTargetLowering } from 'fino:ui';
import type { NormalizedChild, VNode } from 'fino:ui';
import { Box, Text } from 'internal:ui/components/primitives';
import { styles } from 'fino:ui/components/theme';
import { Field, Fieldset, Panel } from 'internal:ui/components/layout';
import type { FieldProps, FieldsetProps, PanelProps } from 'internal:ui/components/layout';

mapRenderTargetLowering(Panel, 'tui', (all: PanelProps): VNode => {
  const { children = [], ...props } = all as PanelProps & { children?: NormalizedChild[] };
  const { title, ...rest } = props;
  return h(
    'box',
    {
      border: true,
      paddingX: 1,
      direction: 'column',
      ...rest,
      ...(title !== undefined ? { borderTitle: title } : {}),
    },
    children,
  );
});

mapRenderTargetLowering(Field, 'tui', (all: FieldProps): VNode => {
  const { children = [], ...props } = all as FieldProps & { children?: NormalizedChild[] };
  const { label, hint, error, required, htmlFor: _htmlFor, id, ...rest } = props;
  return (
    <Box direction="column" id={id} {...rest}>
      <Box direction="row">
        <Text style={[styles.bold]}>{label}</Text>
        {required === true ? <Text style={[styles.danger, styles.bold]}>{' *'}</Text> : null}
      </Box>
      {children}
      {hint !== undefined ? <Text style={[styles.dim]}>{hint}</Text> : null}
      {error !== undefined ? <Text style={[styles.danger]}>{error}</Text> : null}
    </Box>
  );
});

mapRenderTargetLowering(Fieldset, 'tui', (all: FieldsetProps): VNode => {
  const { children = [], ...props } = all as FieldsetProps & { children?: NormalizedChild[] };
  const { legend, ...rest } = props;
  return (
    <Box border paddingX={1} direction="column" borderTitle={legend} {...rest}>
      {children}
    </Box>
  );
});
