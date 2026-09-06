/**
 * internal:sim/faults — deterministic failure injection at the Realm RPC boundary.
 *
 * Faults claim selected Facade requests before the live dispatcher sees them.
 * The caller supplies the random source, so scheduling policy stays separate
 * from transport interception and can use a stream independent of guest
 * randomness. Detaching restores ordinary dispatch.
 *
 * @internal
 */
import { EnvelopeKind, type EnvelopeKindValue } from 'internal:realm/envelope';
import type { RandomSource } from 'internal:runtime/random';

interface FaultTransportPort {
  _addControlHandler(
    handler: (
      envelope: { kind: EnvelopeKindValue; correlation: number },
      value: unknown,
    ) => boolean,
    options?: { first?: boolean },
  ): () => void;
  _postControl(kind: EnvelopeKindValue, correlation: number, value: unknown): void;
}

/** Settings for deterministic Realm RPC failures. @internal */
export interface RpcFaultOptions {
  /** Probability in the inclusive range from zero through one. */
  errorRate: number;
  /** Limit injection to these Facade specifiers. All specifiers are eligible when omitted. */
  specifiers?: ReadonlySet<string>;
  /** Error text delivered to the guest. A call-specific message is used when omitted. */
  message?: string;
}

function isFaultPort(value: unknown): value is FaultTransportPort {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { _addControlHandler?: unknown })._addControlHandler === 'function' &&
    typeof (value as { _postControl?: unknown })._postControl === 'function'
  );
}

function isRequestKind(kind: EnvelopeKindValue): boolean {
  return (
    kind === EnvelopeKind.RpcRequest ||
    kind === EnvelopeKind.RpcStreamRequest ||
    kind === EnvelopeKind.SinkStart
  );
}

/**
 * Claim a deterministic share of Facade requests before live handlers.
 *
 * `port` owns handler ordering and `random` owns the repeatable draw sequence.
 * The returned function removes the interceptor without closing either object.
 *
 * @internal
 */
export function bindRpcFaults(
  port: unknown,
  random: RandomSource,
  options: RpcFaultOptions,
): () => void {
  if (!isFaultPort(port)) {
    throw new TypeError('RPC fault injection requires a controllable Realm transport port');
  }
  if (!Number.isFinite(options.errorRate) || options.errorRate < 0 || options.errorRate > 1) {
    throw new TypeError('RPC fault errorRate must be between 0 and 1');
  }
  return port._addControlHandler(
    (envelope, value) => {
      if (!isRequestKind(envelope.kind)) return false;
      const request = (value ?? {}) as { specifier?: unknown; method?: unknown };
      if (typeof request.specifier !== 'string' || typeof request.method !== 'string') return false;
      if (options.specifiers !== undefined && !options.specifiers.has(request.specifier)) {
        return false;
      }
      if (random.nextFloat() >= options.errorRate) return false;

      const message =
        options.message ?? `fino:sim — injected fault in ${request.specifier}.${request.method}`;
      port._postControl(
        envelope.kind === EnvelopeKind.RpcStreamRequest
          ? EnvelopeKind.RpcError
          : EnvelopeKind.RpcResponse,
        envelope.correlation,
        { error: message },
      );
      return true;
    },
    { first: true },
  );
}
