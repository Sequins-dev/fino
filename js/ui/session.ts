/**
 * fino:ui/session — portable UI session, state, action, and navigation contracts.
 *
 * This module defines the data boundary shared by every server-driven UI host.
 * SSE remains the delivery interface, while browser forms, terminal controls,
 * and external native clients adapt their local interactions into the same
 * versioned action and reconnect requests.
 *
 * It deliberately contains no connection loop and no renderer. The existing
 * `fino:ui/web` adapter continues to own browser cookies, CSRF, `FormData`, and
 * no-JavaScript POST-redirect-GET behavior. A native adapter can use different
 * authentication and input collection while producing the same JSON contract.
 *
 * ## State ownership
 *
 * | State | Authority | Persistence | Wire behavior |
 * | --- | --- | --- | --- |
 * | Client | Client target | Ephemeral | Never sent as server state |
 * | Server | UI session | Durable snapshot | Sent by revision |
 * | Navigation | Shared | URL or native route | Explicit navigation data |
 * | Domain | Application | External system | Referenced through invalidation |
 *
 * Stable component keys identify client-owned state such as focus, selection,
 * scroll position, animation, and native view storage. That state remains local
 * and is not accepted by the request normalizers.
 *
 * ## Compatibility
 *
 * Every request carries an explicit contract version. Version negotiation
 * selects the highest mutually supported version; unknown versions fail
 * instead of being interpreted as the current shape. Migration support is
 * therefore additive and explicit. Product retention windows for old versions
 * remain a deployment policy rather than an implicit decoder behavior.
 *
 * ```ts no_run
 * import {
 *   UI_SESSION_CONTRACT_VERSION,
 *   normalizeUIActionRequest,
 * } from 'fino:ui/session';
 *
 * const request = normalizeUIActionRequest({
 *   contractVersion: UI_SESSION_CONTRACT_VERSION,
 *   view: 'todos',
 *   viewId: 'view-a',
 *   regionId: 'todos-form',
 *   revision: 3,
 *   action: 'add',
 *   requestId: '3:request-a',
 *   input: { text: 'Write tests' },
 * });
 * ```
 */

/**
 * Current portable UI session contract version.
 *
 * This versions host-neutral request and ownership data, not the SSE framing
 * vocabulary introduced by the protocol layer.
 */
export const UI_SESSION_CONTRACT_VERSION = 1 as const;

/**
 * JSON value accepted at the portable UI session boundary.
 */
export type UIJsonValue =
  | null
  | boolean
  | number
  | string
  | UIJsonValue[]
  | { [key: string]: UIJsonValue };

/**
 * JSON object accepted as typed UI action input.
 */
export type UIJsonObject = { [key: string]: UIJsonValue };

/**
 * Portable action request produced by every host adapter.
 */
export interface UIActionRequest {
  /** Exact session contract version used to encode this request. */
  contractVersion: typeof UI_SESSION_CONTRACT_VERSION;
  /** Optional authenticated session identity supplied by the host adapter. */
  sessionId?: string;
  /** Stable server-side view definition name. */
  view: string;
  /** Mounted view-instance identity. */
  viewId: string;
  /** Stable rendered region that originated the action. */
  regionId: string;
  /** Server revision on which the interaction was based. */
  revision: number;
  /** Action name within the view definition. */
  action: string;
  /** Idempotency identity unique within the view revision window. */
  requestId: string;
  /** Stable semantic component key that originated the action, when known. */
  componentKey?: string | number;
  /** Typed JSON action input collected by the target adapter. */
  input: UIJsonObject;
}

/**
 * One reconnect cursor for a mounted view.
 */
export interface UIViewCursor {
  /** Mounted view-instance identity. */
  viewId: string;
  /** Last fully applied server revision. */
  revision: number;
}

/**
 * Portable reconnect request represented through standard SSE reconnect data.
 */
export interface UIResumeRequest {
  /** Exact session contract version understood by the client. */
  contractVersion: typeof UI_SESSION_CONTRACT_VERSION;
  /** Optional authenticated session identity supplied by the host adapter. */
  sessionId?: string;
  /** Last applied revision for every mounted view the client wants to resume. */
  cursors: UIViewCursor[];
}

/**
 * Contract versions advertised by a UI client.
 */
export interface UISessionCapabilities {
  /** Supported contract versions, in any order. */
  contractVersions: number[];
}

/**
 * Host-neutral navigation instruction.
 */
export interface UINavigation {
  /** Application-defined URL, route, or destination identifier. */
  destination: string;
  /** Replace the current history entry instead of pushing a new entry. */
  replace: boolean;
}

/**
 * Fixed ownership rule for one class of UI state.
 */
export interface UIStateOwnershipRule {
  /** System authoritative for this state class. */
  authority: 'client' | 'server' | 'shared' | 'application';
  /** Persistence mechanism for this state class. */
  persistence: 'ephemeral' | 'snapshot' | 'location' | 'external';
  /** Whether the UI session transmits values for this state class. */
  transmitted: boolean;
}

/**
 * Cross-host UI state ownership model.
 *
 * The value is frozen and data-only so adapters and generated clients can
 * inspect it without importing renderer or transport code.
 */
export const UI_STATE_OWNERSHIP: Readonly<
  Record<'client' | 'server' | 'navigation' | 'domain', Readonly<UIStateOwnershipRule>>
> = Object.freeze({
  client: Object.freeze({
    authority: 'client',
    persistence: 'ephemeral',
    transmitted: false,
  }),
  server: Object.freeze({
    authority: 'server',
    persistence: 'snapshot',
    transmitted: true,
  }),
  navigation: Object.freeze({
    authority: 'shared',
    persistence: 'location',
    transmitted: true,
  }),
  domain: Object.freeze({
    authority: 'application',
    persistence: 'external',
    transmitted: false,
  }),
});

function failJson(path: string, detail: string): never {
  throw new TypeError(`${path} must be JSON-compatible: ${detail}`);
}

function cloneJson(value: unknown, path: string, ancestors = new Set<object>()): UIJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return failJson(path, 'numbers must be finite');
    return value;
  }
  if (typeof value !== 'object') return failJson(path, `received ${typeof value}`);
  if (ancestors.has(value)) return failJson(path, 'cyclic values are not supported');
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(value);
  if (Array.isArray(value))
    return value.map((item, index) => cloneJson(item, `${path}[${index}]`, nextAncestors));
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null)
    return failJson(path, 'only plain objects and arrays are supported');
  const out: UIJsonObject = {};
  for (const [key, item] of Object.entries(value))
    out[key] = cloneJson(item, `${path}.${key}`, nextAncestors);
  return out;
}

function jsonObject(value: unknown, path: string): UIJsonObject {
  const cloned = cloneJson(value, path);
  if (typeof cloned !== 'object' || cloned === null || Array.isArray(cloned))
    throw new TypeError(`${path} must be a JSON object`);
  return cloned;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function portableName(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
  )
    throw new TypeError(`${name} must be a non-empty portable identifier`);
  return value;
}

function opaqueIdentifier(value: unknown, name: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 1024 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new TypeError(`${name} must be a non-empty opaque identifier`);
  return value;
}

function optionalOpaqueIdentifier(value: unknown, name: string): string | undefined {
  return value === undefined ? undefined : opaqueIdentifier(value, name);
}

function revision(value: unknown, name = 'revision'): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${name} must be a non-negative safe integer`);
  return value as number;
}

function contractVersion(value: unknown): typeof UI_SESSION_CONTRACT_VERSION {
  if (value !== UI_SESSION_CONTRACT_VERSION)
    throw new TypeError(`unsupported UI session contract version ${String(value)}`);
  return UI_SESSION_CONTRACT_VERSION;
}

/**
 * Validate and detach a portable UI action request.
 *
 * Unknown fields are ignored. The returned action input is a deep JSON clone,
 * preventing host-local objects or later caller mutation from crossing the
 * shared execution boundary.
 */
export function normalizeUIActionRequest(value: unknown): UIActionRequest {
  const input = record(value, 'UI action request');
  const sessionId = optionalOpaqueIdentifier(input.sessionId, 'sessionId');
  const componentKey = input.componentKey;
  if (
    componentKey !== undefined &&
    typeof componentKey !== 'string' &&
    typeof componentKey !== 'number'
  )
    throw new TypeError('componentKey must be a string or number');
  if (
    typeof componentKey === 'number' &&
    (!Number.isSafeInteger(componentKey) || !Number.isFinite(componentKey))
  )
    throw new TypeError('numeric componentKey must be a safe integer');
  return {
    contractVersion: contractVersion(input.contractVersion),
    ...(sessionId === undefined ? {} : { sessionId }),
    view: portableName(input.view, 'view'),
    viewId: opaqueIdentifier(input.viewId, 'viewId'),
    regionId: opaqueIdentifier(input.regionId, 'regionId'),
    revision: revision(input.revision),
    action: portableName(input.action, 'action'),
    requestId: opaqueIdentifier(input.requestId, 'requestId'),
    ...(componentKey === undefined ? {} : { componentKey }),
    input: jsonObject(input.input, 'action input'),
  };
}

/**
 * Validate and detach a reconnect request.
 *
 * Duplicate mounted view ids are rejected because one reconnect request cannot
 * claim two different last-applied revisions for the same view.
 */
export function normalizeUIResumeRequest(value: unknown): UIResumeRequest {
  const input = record(value, 'UI resume request');
  if (!Array.isArray(input.cursors) || input.cursors.length === 0)
    throw new TypeError('UI resume request cursors must be a non-empty array');
  const seen = new Set<string>();
  const cursors = input.cursors.map((cursor, index) => {
    const item = record(cursor, `cursors[${index}]`);
    const viewId = opaqueIdentifier(item.viewId, `cursors[${index}].viewId`);
    if (seen.has(viewId)) throw new TypeError(`duplicate viewId "${viewId}" in UI resume request`);
    seen.add(viewId);
    return {
      viewId,
      revision: revision(item.revision, `cursors[${index}].revision`),
    };
  });
  const sessionId = optionalOpaqueIdentifier(input.sessionId, 'sessionId');
  return {
    contractVersion: contractVersion(input.contractVersion),
    ...(sessionId === undefined ? {} : { sessionId }),
    cursors,
  };
}

/**
 * Validate and detach a host-neutral navigation instruction.
 */
export function normalizeUINavigation(value: unknown): UINavigation {
  const input = record(value, 'UI navigation');
  if (typeof input.destination !== 'string' || input.destination.length === 0)
    throw new TypeError('navigation destination must be a non-empty string');
  if (input.replace !== undefined && typeof input.replace !== 'boolean')
    throw new TypeError('navigation replace must be a boolean');
  return {
    destination: input.destination,
    replace: input.replace ?? false,
  };
}

/**
 * Select the highest UI session contract version supported by both peers.
 *
 * The server currently supports `UI_SESSION_CONTRACT_VERSION`. The function
 * accepts a capability object so future versions can be negotiated without
 * changing connection setup. It throws when no version is shared.
 */
export function negotiateUISessionVersion(
  capabilities: UISessionCapabilities,
): typeof UI_SESSION_CONTRACT_VERSION {
  if (
    typeof capabilities !== 'object' ||
    capabilities === null ||
    !Array.isArray(capabilities.contractVersions)
  )
    throw new TypeError('UI session capabilities must list contractVersions');
  if (capabilities.contractVersions.includes(UI_SESSION_CONTRACT_VERSION))
    return UI_SESSION_CONTRACT_VERSION;
  throw new Error('No compatible UI session contract version');
}
