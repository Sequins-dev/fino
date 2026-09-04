/**
 * Terminal render-target definition and shared lowering entry point.
 *
 * Semantic family lowerings register from their co-located modules. The target
 * owns only the closed primitive floor accepted by retained terminal layout.
 *
 * @internal
 */
import { defineRenderTarget, lowerTree } from 'fino:ui';
import type { VNode } from 'fino:ui';
import 'internal:ui/components/icons.tui';
import 'internal:ui/components/layout.tui';
import 'internal:ui/components/typography.tui';
import 'internal:ui/components/forms.tui';
import 'internal:ui/components/disclosure.tui';
import 'internal:ui/components/menu.tui';
import 'internal:ui/components/navigation.tui';
import 'internal:ui/components/overlay.tui';
import 'internal:ui/components/feedback.tui';
import 'internal:ui/components/display.tui';
import 'internal:ui/components/data.tui';
import 'internal:ui/components/virtual.tui';
import 'internal:ui/components/pickers.tui';
import 'internal:ui/components/charts.tui';

export { holdSpinnerClock } from 'internal:ui/components/feedback.tui';

/** Node names painted directly by the retained terminal target. */
export const TUI_PRIMITIVES = [
  'fragment',
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

/** Lower a host-neutral component tree to terminal primitives. */
export function lowerTui(node: VNode): VNode {
  return lowerTree(node, 'tui');
}
