/**
 * fino:ui/jsx-runtime — automatic JSX runtime for `fino:ui`.
 *
 * This module is the TypeScript `react-jsx` compatible entry point for Fino UI
 * components. It delegates every JSX element to `h()` from `fino:ui`, so JSX and
 * manual `h()` calls produce the same host-neutral VNodes.
 *
 * ```ts no_run
 * /** @jsxImportSource fino:ui *\/
 *
 * export function Label() {
 *   return <text>Hello</text>;
 * }
 * ```
 */
import { Fragment, h, type Child, type Props, type VNode, type VNodeType } from 'fino:ui';
export { Fragment };
/**
 * TypeScript JSX types shared by `.tsx` applications using Fino's automatic
 * runtime. Intrinsic element names and attributes remain host-defined, so the
 * base runtime accepts any element while preserving type checking for component
 * props.
 */
export namespace JSX {
  /** Value returned from JSX expressions. */
  export type Element = VNode;
  /** Property containing nested JSX children. */
  export interface ElementChildrenAttribute {
    children: Child;
  }
  /** Host elements are intentionally renderer-defined. */
  export interface IntrinsicElements {
    [name: string]: Props;
  }
}
/**
 * Create one VNode for TypeScript's automatic JSX transform.
 *
 * `children` may be supplied through props by the compiler and is normalized by
 * `h()`.
 *
 * `key`, when supplied by the compiler, is copied into props before delegating
 * to `h()` so reconciliation sees the same key as a manual `h()` call.
 */
export function jsx(
  type: VNodeType,
  props:
    | (Props & {
        children?: Child;
      })
    | null,
  key?: string,
): VNode {
  const nextProps =
    key === undefined
      ? props
      : {
          ...(props ?? {}),
          key,
        };
  return h(type, nextProps);
}
/**
 * Create one VNode for JSX elements with multiple static children.
 *
 * This has the same behavior as `jsx()`; it exists because TypeScript emits a
 * separate helper when an element contains multiple children.
 *
 * Use `jsxImportSource: "fino:ui"` or a file-level `@jsxImportSource` comment
 * so TypeScript imports this helper automatically.
 */
export function jsxs(
  type: VNodeType,
  props:
    | (Props & {
        children?: Child;
      })
    | null,
  key?: string,
): VNode {
  return jsx(type, props, key);
}
/**
 * Development JSX helper.
 *
 * Fino does not add development-only owner metadata, so this delegates to
 * `jsx()`.
 *
 * Extra compiler-provided development arguments are intentionally ignored by
 * this runtime surface.
 */
export function jsxDEV(
  type: VNodeType,
  props:
    | (Props & {
        children?: Child;
      })
    | null,
  key?: string,
): VNode {
  return jsx(type, props, key);
}
