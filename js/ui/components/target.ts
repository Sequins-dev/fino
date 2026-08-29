/**
 * Shared render-target registration helpers for the component catalog.
 *
 * @internal
 */
import { mapRenderTargetLowering } from 'fino:ui';
import type {
  Component,
  NormalizedChild,
  Props,
  RenderTargetName,
  RenderTargetRegistration,
  VNode,
} from 'fino:ui';

/** Props passed to a target lowering after normalized children are extracted. */
export type LoweringProps<P> = Omit<P, 'children'>;

/** Target-specific implementation with children kept separate from props. */
export type ComponentLowering<P> = (props: LoweringProps<P>, children: NormalizedChild[]) => VNode;

/**
 * Register a typed component lowering and normalize its child plumbing once.
 *
 * Family modules use this instead of repeating casts and `children` removal
 * for every HTML or terminal implementation.
 */
export function mapComponentLowering<P extends Props>(
  component: Component<P>,
  target: RenderTargetName,
  lowering: ComponentLowering<P>,
): RenderTargetRegistration {
  return mapRenderTargetLowering(component, target, (all: P): VNode => {
    const input = all as Props & { children?: NormalizedChild[] };
    const { children = [], ...props } = input;
    return lowering(props as LoweringProps<P>, children);
  });
}

const htmlCssFragments = new Set<string>();

/** Register a co-located component-family stylesheet fragment. */
export function registerHtmlCss(css: string): void {
  const normalized = css.trim();
  if (normalized.length > 0) htmlCssFragments.add(normalized);
}

/** Return registered family CSS in deterministic registration order. */
export function registeredHtmlCss(): string {
  return [...htmlCssFragments].join('\n\n');
}
