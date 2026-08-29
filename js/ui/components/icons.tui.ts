/**
 * Terminal lowerings for icon components.
 *
 * @internal
 */
import { h } from 'fino:ui';
import type { Props } from 'fino:ui';
import { Clickable, Text } from 'fino:ui/components';
import { styles } from 'fino:ui/components/theme';
import { Icon, IconButton, iconForm } from 'internal:ui/components/icons';
import { mapComponentLowering } from 'internal:ui/components/target';

mapComponentLowering(Icon, 'tui', (props) => {
  const { name, label: _label, icons, ...rest } = props;
  return h(Text, rest as Props, iconForm(name, 'tui', icons));
});

mapComponentLowering(IconButton, 'tui', (props) => {
  const { icon, label: _label, onClick, focused, disabled, icons, ...rest } = props;
  const style =
    disabled === true ? [styles.dim] : focused === true ? [styles.bold, styles.accent] : [];
  return h(
    Clickable,
    { ...rest, onClick, disabled } as Props,
    h(Text, { style }, iconForm(icon, 'tui', icons)),
  );
});
