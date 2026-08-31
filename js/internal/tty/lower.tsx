/**
 * internal:tty/lower — the terminal render target.
 *
 * The catalog's components render native web markup by default, so the
 * terminal declares itself as a target: the node names it paints, and — by
 * importing the `*.tui` module beside each component family — the lowerings
 * that turn a semantic component into those names. Registration is the
 * side effect of the imports below; nothing here knows what a checkbox is.
 *
 * `fino:tty/tui` runs `lowerTui()` over every tree before layout and
 * reconciliation, so the retained tree and the event dispatcher only ever see
 * primitives.
 */
import { defineRenderTarget, lowerTree } from 'fino:ui';
import type { VNode } from 'fino:ui';
// Terminal lowerings live beside the components they replace; these imports
// exist for their registration side effects.
import 'internal:ui/components/charts.tui';
import 'internal:ui/components/data.tui';
import 'internal:ui/components/disclosure.tui';
import 'internal:ui/components/display.tui';
import 'internal:ui/components/feedback.tui';
import 'internal:ui/components/forms.tui';
import 'internal:ui/components/icons.tui';
import 'internal:ui/components/layout.tui';
import 'internal:ui/components/menu.tui';
import 'internal:ui/components/navigation.tui';
import 'internal:ui/components/overlay.tui';
import 'internal:ui/components/pickers.tui';
import 'internal:ui/components/typography.tui';
import 'internal:ui/components/virtual.tui';
// Re-exported so `fino:tty/tui` can bound the spinner clock to the life of a
// live app without importing a component module directly.
export { holdSpinnerClock } from 'internal:ui/components/feedback.tui';

/**
 * The node names the terminal paints itself.
 *
 * This is the target's floor: lowering stops here, and anything else reaching
 * it without a registered lowering is an error rather than a silently empty
 * box. `button` and `list` are the older `fino:tty/tui` primitives, still
 * handled by the layout engine.
 */
const TUI_PRIMITIVES = [
  'fragment',
  // Retained host text nodes, so lowering an already-mounted tree is a no-op
  // rather than an error.
  '#text',
  'box',
  'text',
  'spacer',
  'rule',
  'input',
  'button',
  'list',
  'clickable',
  'scrollview',
  'layer',
  'measured',
];

defineRenderTarget('tui', { primitives: TUI_PRIMITIVES });

/**
 * Lower a semantic tree to terminal primitives.
 *
 * Thin wrapper over `lowerTree(node, 'tui')`, kept because the terminal target
 * and its tests name this operation directly.
 */
export function lowerTui(node: VNode): VNode {
  return lowerTree(node, 'tui');
}
