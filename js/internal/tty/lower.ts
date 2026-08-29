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
];

defineRenderTarget('tui', { primitives: TUI_PRIMITIVES });

/** Lower a host-neutral component tree to terminal primitives. */
export function lowerTui(node: VNode): VNode {
  return lowerTree(node, 'tui');
}
