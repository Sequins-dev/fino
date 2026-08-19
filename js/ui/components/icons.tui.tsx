/** @jsxImportSource fino:ui */
/**
 * internal:ui/components/icons.tui — terminal forms for the icon registry components.
 *
 * @internal
 */
import { mapRenderTargetLowering } from 'fino:ui';
import type { NormalizedChild, VNode } from 'fino:ui';
import { Clickable, Text } from 'internal:ui/components/primitives';
import { styles } from 'fino:ui/components/theme';
import { iconForm } from 'internal:ui/components/icons';
import { Icon, IconButton } from 'internal:ui/components/icons';
import type { IconButtonProps, IconProps } from 'internal:ui/components/icons';

mapRenderTargetLowering(Icon, 'tui', (all: IconProps): VNode => {
  const { children = [], ...props } = all as IconProps & { children?: NormalizedChild[] };
  const { name, label: _label, icons, id, ...rest } = props;
  return (
    <Text id={id} {...rest}>
      {iconForm(name, 'tui', icons)}
    </Text>
  );
});

mapRenderTargetLowering(IconButton, 'tui', (all: IconButtonProps): VNode => {
  const { children = [], ...props } = all as IconButtonProps & { children?: NormalizedChild[] };
  const { icon, label: _label, onClick, focused, disabled, icons, id, ...rest } = props;
  return (
    <Clickable id={id} onClick={onClick} disabled={disabled} {...rest}>
      <Text
        style={
          disabled === true ? [styles.dim] : focused === true ? [styles.bold, styles.accent] : []
        }
      >
        {iconForm(icon, 'tui', icons)}
      </Text>
    </Clickable>
  );
});
