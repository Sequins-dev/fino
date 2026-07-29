/**
 * fino:ui/components — semantic components with target-local implementations.
 *
 * This module extends the existing `fino:ui` VNode tree with wire-safe
 * component metadata. Applications define namespaced, versioned components
 * backed by JSON Schema. A component invocation still produces an ordinary
 * VNode, but the node carries the component id, schema fingerprint, declared
 * slots, and fallback id needed by remote render targets.
 *
 * Renderers stay entirely client-local. A `ComponentRegistry` maps semantic
 * component references to HTML, terminal, or external native implementations
 * and exposes a data-only capability manifest. Executable renderer functions
 * are never included in VNodes or capability data.
 *
 * ## Identity and state
 *
 * VNode keys remain the cross-target instance identity. Clients should use
 * them to preserve target-owned state such as focus, scroll position,
 * animation, and native view storage across server updates. Semantic props
 * carry server-owned meaning and actions; they should not encode CSS,
 * SwiftUI modifiers, Compose modifiers, or other target implementation detail.
 *
 * ## Compatibility
 *
 * Component names are lowercase namespaces such as `app.profile-card`.
 * Versions are positive integers and produce ids such as
 * `app.profile-card.v1`. Registries require an exact id and schema fingerprint
 * unless the server descriptor declares a fallback component id.
 *
 * The schema fingerprint is deterministic but not cryptographic. It is a
 * compatibility key, not an integrity or security mechanism.
 *
 * ```ts no_run
 * import { h } from 'fino:ui';
 * import { ComponentRegistry, defineComponent } from 'fino:ui/components';
 * import { v } from 'fino:validate';
 *
 * const Button = defineComponent<{ label: string }>({
 *   name: 'app.button',
 *   version: 1,
 *   schema: v.object({ label: v.string().min(1) }),
 *   fallback: 'app.unsupported.v1',
 * });
 *
 * const html = new ComponentRegistry('html').register(Button, ({ props }) =>
 *   h('button', null, props.label)
 * );
 *
 * const tree = html.resolve(h(Button, { key: 'save', label: 'Save' }));
 * ```
 */
import {
  type Component,
  type NormalizedChild,
  type Props,
  type VNode,
  type VNodeComponent,
} from 'fino:ui';
import { SchemaBuilder, compile, type CompiledValidator, type JsonSchema } from 'fino:validate';

const COMPONENT_NAME = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/;
const COMPONENT_ID = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+\.v[1-9]\d*$/;
const SLOT_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * JSON value accepted in semantic component props and action payloads.
 *
 * Binary values, dates, functions, symbols, bigint values, non-finite numbers,
 * class instances, and cyclic structures are rejected at runtime.
 */
export type UIJsonValue =
  | null
  | boolean
  | number
  | string
  | UIJsonValue[]
  | { [key: string]: UIJsonValue };

/**
 * JSON object accepted as a semantic action payload or extension map.
 */
export type UIJsonObject = { [key: string]: UIJsonValue };

/**
 * Portable server action reference carried in semantic props.
 *
 * The later SSE action layer binds `name` to a durable view/action definition.
 * `input` contains only fixed JSON arguments; interactive values are supplied
 * by the client action request.
 */
export interface UIActionReference {
  /** Stable action name within the owning view. */
  name: string;
  /** Optional fixed JSON arguments included with the action request. */
  input?: UIJsonObject;
}

/**
 * Portable navigation request carried in semantic props.
 *
 * Targets map `destination` to their native navigation presentation while
 * preserving the same semantic location and replacement behavior.
 */
export interface UINavigationReference {
  /** Application-defined route or destination identifier. */
  destination: string;
  /** Replace the current navigation entry instead of pushing a new entry. */
  replace?: boolean;
}

/**
 * Cross-target accessibility intent for a semantic component.
 *
 * These values describe meaning rather than platform APIs. Renderers translate
 * them into HTML accessibility attributes, terminal semantics, or native
 * accessibility metadata.
 */
export interface UIAccessibility {
  /** Semantic role, such as `button`, `link`, `heading`, or `status`. */
  role?: string;
  /** Accessible label when visible content is insufficient. */
  label?: string;
  /** Additional usage hint presented by assistive technology. */
  hint?: string;
  /** Current semantic value, such as progress or selection text. */
  value?: string;
  /** Whether the component is unavailable for interaction. */
  disabled?: boolean;
  /** Whether assistive technologies should ignore the component. */
  hidden?: boolean;
  /** How updates should be announced by targets that support live regions. */
  live?: 'off' | 'polite' | 'assertive';
}

/**
 * Conventional portable props understood across semantic components.
 *
 * Component schemas opt into the fields they support. `intent` and `variant`
 * are coarse semantic choices; detailed styling remains target-owned.
 */
export interface SemanticComponentProps {
  /** Semantic emphasis such as `primary`, `danger`, or `success`. */
  intent?: string;
  /** Component-defined presentation variant without platform styling detail. */
  variant?: string;
  /** Accessibility meaning translated by the selected target renderer. */
  accessibility?: UIAccessibility;
  /** Server action requested by interaction with the component. */
  action?: UIActionReference;
  /** Navigation requested by interaction with the component. */
  navigation?: UINavigationReference;
}

/**
 * JSON Schema accepted by `defineComponent()`.
 *
 * Raw schemas and `SchemaBuilder` values from `fino:validate` are normalized
 * into a detached canonical schema when the component is defined.
 */
export type ComponentSchema<P = unknown> = JsonSchema | SchemaBuilder<P>;

/**
 * Definition of one portable semantic component version.
 */
export interface SemanticComponentDefinition<P extends object = Props> {
  /**
   * Stable lowercase namespaced name, such as `app.profile-card`.
   *
   * The version suffix is added automatically and must not be included here.
   */
  name: string;
  /** Positive integer incremented when the component contract is incompatible. */
  version: number;
  /** JSON Schema applied to props when each VNode is created. */
  schema: ComponentSchema<P>;
  /** Named child slots understood by this component version. */
  slots?: readonly string[];
  /**
   * Fully versioned component id used when the exact target implementation or
   * schema fingerprint is unavailable.
   */
  fallback?: string;
}

/**
 * Callable semantic component returned by `defineComponent()`.
 *
 * `reference` and `schema` are frozen, data-only metadata suitable for
 * capability negotiation and documentation. Calling the component validates
 * props and returns the existing `fino:ui` VNode shape.
 */
export interface SemanticComponent<P extends object = Props> extends Component<P> {
  /** Wire-safe component identity attached to every produced VNode. */
  readonly reference: VNodeComponent;
  /** Detached canonical JSON Schema used to validate props. */
  readonly schema: JsonSchema;
}

/**
 * Input supplied to a target-local component renderer.
 *
 * `component` is the descriptor requested by the server. `implementation` is
 * the locally registered implementation selected by the registry; they differ
 * when a declared fallback is used.
 */
export interface ComponentRenderInput<P extends object = Props> {
  /** Descriptor requested by the semantic VNode. */
  component: VNodeComponent;
  /** Local implementation descriptor selected by the registry. */
  implementation: VNodeComponent;
  /** Schema-validated JSON props from the semantic VNode. */
  props: P;
  /** Target-resolved children supplied by the server tree. */
  children: NormalizedChild[];
  /** Stable instance key used to preserve target-owned state. */
  key: string | number | null;
  /** Named parent slot occupied by this component, when present. */
  slot?: string;
  /** Whether the selected renderer is the component's declared fallback. */
  fallback: boolean;
}

/**
 * Target-local implementation of one semantic component.
 *
 * The function returns an ordinary VNode containing host primitives or other
 * semantic components. Renderer functions remain local and never appear in
 * capability manifests.
 */
export type ComponentRenderer<P extends object = Props> = (input: ComponentRenderInput<P>) => VNode;

/**
 * Data-only capability manifest advertised by a component registry.
 */
export interface ComponentCapabilityManifest {
  /** Target name chosen by the client, such as `html`, `tui`, or `ios`. */
  target: string;
  /** Exact component versions and schema fingerprints implemented locally. */
  components: VNodeComponent[];
}

interface RegisteredComponent {
  component: SemanticComponent<Props>;
  render: ComponentRenderer<Props>;
}

function failJson(path: string, detail: string): never {
  throw new TypeError(`${path} must be JSON-compatible: ${detail}`);
}

function canonicalJson(value: unknown, path = 'value', ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return failJson(path, 'numbers must be finite');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') return failJson(path, `received ${typeof value}`);
  if (ancestors.has(value)) return failJson(path, 'cyclic values are not supported');
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value)) {
    return `[${value
      .map((item, index) => canonicalJson(item, `${path}[${index}]`, nextAncestors))
      .join(',')}]`;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return failJson(path, 'only plain objects and arrays are supported');
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${canonicalJson(item, `${path}.${key}`, nextAncestors)}`,
    )
    .join(',')}}`;
}

function normalizeSchema(schema: ComponentSchema): JsonSchema {
  const raw = schema instanceof SchemaBuilder ? schema.toJSON() : schema;
  const normalized = JSON.parse(canonicalJson(raw, 'schema')) as unknown;
  if (typeof normalized !== 'object' || normalized === null || Array.isArray(normalized))
    throw new TypeError('component schema must be a JSON object');
  return freezeJson(normalized as JsonSchema);
}

function freezeJson<T extends object>(value: T): T {
  for (const child of Object.values(value)) {
    if (typeof child === 'object' && child !== null) freezeJson(child);
  }
  return Object.freeze(value);
}

function validateDefinition(
  definition: SemanticComponentDefinition,
  id: string,
): readonly string[] | undefined {
  if (!COMPONENT_NAME.test(definition.name))
    throw new TypeError(`component name "${definition.name}" must be a lowercase namespaced name`);
  if (COMPONENT_ID.test(definition.name))
    throw new TypeError(`component name "${definition.name}" must not include a version suffix`);
  if (!Number.isInteger(definition.version) || definition.version <= 0)
    throw new TypeError('component version must be a positive integer');
  if (definition.fallback !== undefined) {
    if (!COMPONENT_ID.test(definition.fallback))
      throw new TypeError(`component fallback "${definition.fallback}" must be a versioned id`);
    if (definition.fallback === id)
      throw new TypeError('component fallback must not reference the component itself');
  }
  if (definition.slots === undefined) return undefined;
  const slots = Array.from(definition.slots);
  const seen = new Set<string>();
  for (const slot of slots) {
    if (!SLOT_NAME.test(slot))
      throw new TypeError(`component slot "${slot}" must be a lowercase name`);
    if (seen.has(slot)) throw new TypeError(`component slot "${slot}" is duplicated`);
    seen.add(slot);
  }
  return Object.freeze(slots);
}

/**
 * Compute a deterministic compatibility fingerprint for a JSON Schema.
 *
 * Object keys are sorted recursively before hashing, so equivalent schema
 * objects produce the same result regardless of property insertion order.
 * Arrays retain their declared order.
 *
 * The result uses 32-bit FNV-1a and is prefixed with `fnv1a32:`. It detects
 * ordinary compatibility drift but is not collision-resistant and must not be
 * used as a signature or integrity check.
 */
export function componentSchemaFingerprint(schema: ComponentSchema): string {
  const canonical = canonicalJson(
    schema instanceof SchemaBuilder ? schema.toJSON() : schema,
    'schema',
  );
  let hash = 2166136261;
  for (let index = 0; index < canonical.length; index++) {
    hash ^= canonical.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

/**
 * Define one namespaced, schema-validated semantic component.
 *
 * Props are validated and defaulted through `fino:validate`, then checked for
 * JSON compatibility. `children`, `key`, and `slot` are VNode structure rather
 * than schema props: `h()` owns `key`, normalized children remain in
 * `VNode.children`, and this function moves a non-empty string `slot` onto the
 * VNode.
 *
 * Throws for invalid names, versions, slots, fallback ids, schemas, props, or
 * non-JSON values.
 */
export function defineComponent<P extends object>(
  definition: SemanticComponentDefinition<P>,
): SemanticComponent<P> {
  const id = `${definition.name}.v${definition.version}`;
  const slots = validateDefinition(definition, id);
  const schema = normalizeSchema(definition.schema);
  const validator: CompiledValidator<P> = compile<P>(schema);
  const reference = Object.freeze({
    id,
    name: definition.name,
    version: definition.version,
    schemaFingerprint: componentSchemaFingerprint(schema),
    ...(slots === undefined ? {} : { slots }),
    ...(definition.fallback === undefined ? {} : { fallback: definition.fallback }),
  }) as VNodeComponent;
  const component = ((input: P & { children?: NormalizedChild[]; slot?: unknown }) => {
    const { children = [], slot, ...rawProps } = input;
    if (slot !== undefined && (typeof slot !== 'string' || slot.length === 0))
      throw new TypeError('component slot must be a non-empty string');
    for (const child of children) {
      if (typeof child === 'string' || child.slot === undefined) continue;
      if (slots === undefined || !slots.includes(child.slot))
        throw new TypeError(`component ${id} does not declare child slot "${child.slot}"`);
    }
    const props = validator.parse(rawProps) as Props;
    canonicalJson(props, 'component props');
    return {
      type: id,
      props,
      children,
      key: null,
      component: reference,
      ...(slot === undefined ? {} : { slot }),
    };
  }) as SemanticComponent<P>;
  Object.defineProperties(component, {
    reference: {
      value: reference,
      enumerable: true,
    },
    schema: {
      value: schema,
      enumerable: true,
    },
  });
  return Object.freeze(component);
}

/**
 * Error raised when a registry cannot resolve a semantic component.
 *
 * `component` identifies the server-requested contract, `target` identifies the
 * local registry, and `reason` distinguishes a missing implementation from an
 * incompatible schema fingerprint or missing declared fallback.
 */
export class UnsupportedComponentError extends Error {
  /** Semantic component requested by the server tree. */
  readonly component: VNodeComponent;
  /** Client target whose registry could not resolve the component. */
  readonly target: string;
  /** Compatibility failure suitable for developer diagnostics. */
  readonly reason: string;

  /** Create an unsupported-component error with stable diagnostic fields. */
  constructor(target: string, component: VNodeComponent, reason: string) {
    super(`Unsupported component ${component.id} on ${target}: ${reason}`);
    this.name = 'UnsupportedComponentError';
    this.target = target;
    this.component = component;
    this.reason = reason;
  }
}

function semanticReference(node: VNode): VNodeComponent | undefined {
  return node.component;
}

/**
 * Registry of target-local implementations for semantic components.
 *
 * A registry is owned by one client target. `register()` stores executable
 * renderers locally, `capabilities()` exposes only data descriptors, and
 * `resolve()` recursively lowers semantic nodes into host VNodes.
 */
export class ComponentRegistry {
  #target: string;
  #components = new Map<string, RegisteredComponent>();

  /**
   * Create an empty registry for `target`.
   *
   * `target` is an application-defined non-empty name included in capability
   * negotiation, such as `html`, `tui`, `ios`, or `android`.
   */
  constructor(target: string) {
    if (typeof target !== 'string' || target.trim().length === 0)
      throw new TypeError('component registry target must be a non-empty string');
    this.#target = target;
  }

  /**
   * Register one exact semantic component implementation.
   *
   * Duplicate ids throw instead of replacing an implementation silently.
   * Registration is local to this registry; the renderer function never
   * appears in `capabilities()`.
   */
  register<P extends object>(component: SemanticComponent<P>, render: ComponentRenderer<P>): this {
    const id = component.reference.id;
    if (this.#components.has(id))
      throw new Error(`component ${id} is already registered for ${this.#target}`);
    this.#components.set(id, {
      component: component as unknown as SemanticComponent<Props>,
      render: render as unknown as ComponentRenderer<Props>,
    });
    return this;
  }

  /**
   * Return a deterministic data-only capability manifest.
   *
   * Components are sorted by id. The returned arrays are new values, so callers
   * may serialize or modify the manifest without mutating the registry.
   */
  capabilities(): ComponentCapabilityManifest {
    return {
      target: this.#target,
      components: Array.from(this.#components.values())
        .map(({ component }) => component.reference)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    };
  }

  /**
   * Recursively lower a semantic VNode tree into target host VNodes.
   *
   * Exact id and schema matches select their registered renderer. When either
   * is unavailable, a declared fallback id may select a registered fallback
   * renderer. Missing implementations, incompatible schemas without a usable
   * fallback, and renderer cycles throw `UnsupportedComponentError` or `Error`.
   *
   * The semantic node's key and slot are copied onto renderer output so native
   * targets can preserve instance identity and placement.
   */
  resolve(tree: VNode): VNode {
    return this.#resolve(tree, new Set<string>());
  }

  #resolve(tree: VNode, stack: Set<string>): VNode {
    const requested = semanticReference(tree);
    if (requested === undefined) {
      return {
        ...tree,
        children: tree.children.map((child) =>
          typeof child === 'string' ? child : this.#resolve(child, stack),
        ),
      };
    }
    const exact = this.#components.get(requested.id);
    let selected = exact;
    let fallback = false;
    let incompatibility =
      exact === undefined
        ? 'no implementation is registered'
        : `schema ${requested.schemaFingerprint} does not match ${exact.component.reference.schemaFingerprint}`;
    if (
      exact !== undefined &&
      exact.component.reference.schemaFingerprint === requested.schemaFingerprint
    ) {
      incompatibility = '';
    } else {
      selected =
        requested.fallback === undefined ? undefined : this.#components.get(requested.fallback);
      fallback = selected !== undefined;
    }
    if (selected === undefined) {
      const fallbackDetail =
        requested.fallback === undefined
          ? ''
          : `; fallback ${requested.fallback} is not registered`;
      throw new UnsupportedComponentError(
        this.#target,
        requested,
        `${incompatibility}${fallbackDetail}`,
      );
    }
    const cycleKey = `${requested.id}:${requested.schemaFingerprint}`;
    if (stack.has(cycleKey))
      throw new Error(`component renderer cycle detected for ${requested.id}`);
    const children = tree.children.map((child) =>
      typeof child === 'string' ? child : this.#resolve(child, stack),
    );
    const nextStack = new Set(stack);
    nextStack.add(cycleKey);
    const output = selected.render({
      component: requested,
      implementation: selected.component.reference,
      props: tree.props,
      children,
      key: tree.key,
      slot: tree.slot,
      fallback,
    });
    const identified = {
      ...output,
      key: tree.key === null ? output.key : tree.key,
      ...(tree.slot === undefined ? {} : { slot: tree.slot }),
    };
    return this.#resolve(identified, nextStack);
  }
}
