/**
 * internal:realm/envelope — control metadata for realm messages.
 *
 * A realm message is two independent things: an opaque clone of a user value,
 * and the runtime's own description of what that value is for. This module owns
 * the second part.
 *
 * Keeping them separate matters for two reasons. Control information nested
 * inside the cloned payload can be forged — any realm able to post a plain
 * object could previously fabricate an RPC response or a termination request
 * simply by setting the right property on it. And a relay that only needs to
 * know *where* a message is going should not have to deserialize *what* it
 * contains; a header it can read on its own lets a message be forwarded, or
 * recognised as a control signal, without ever decoding the payload.
 *
 * The encoding is deliberately small and fixed: a version byte, a kind byte, and
 * a correlation id. It is not a general serialization format, and it never
 * carries user data.
 *
 * @internal
 */

/**
 * What a realm message is for.
 *
 * `message` is ordinary application traffic — everything else is runtime
 * protocol that used to ride as a magic property on the payload.
 */
export const EnvelopeKind = {
  /** Application `postMessage` traffic. The payload is the user's value. */
  Message: 0,
  /** Invoke the child's default export. Payload is the argument list. */
  Call: 1,
  /** Successful result of a `Call`. Payload is the return value. */
  CallResult: 2,
  /** Failed `Call`. Payload describes the error. */
  CallError: 3,
  /** Ask a realm to shut down. No payload. */
  Terminate: 4,
  /** Facade request from child to parent. Payload holds specifier/method/args. */
  RpcRequest: 5,
  /** Terminal facade response. Payload is the result, or an error description. */
  RpcResponse: 6,
  /** One item of a streaming facade response. */
  RpcChunk: 7,
  /** End of a streaming facade response. No payload. */
  RpcEnd: 8,
  /** Failure of a streaming facade response. Payload describes the error. */
  RpcError: 9,
  /** Begin a child-to-parent write stream. Payload holds specifier/method/args. */
  SinkStart: 10,
  /** One item written to a child-to-parent write stream. */
  SinkChunk: 11,
  /** End of a child-to-parent write stream. No payload. */
  SinkEnd: 12,
  /** Abort of a child-to-parent write stream. Payload describes the error. */
  SinkError: 13,
  /** Begin a parent-to-child read stream. Payload holds specifier/method/args. */
  RpcStreamRequest: 14,
  /** Normalized V8 coverage submitted by a child to its owning Realm. */
  Coverage: 15,
} as const;

export type EnvelopeKindValue = (typeof EnvelopeKind)[keyof typeof EnvelopeKind];

/** Envelope metadata describing a realm message. */
export interface Envelope {
  kind: EnvelopeKindValue;
  /**
   * Request identifier tying a response, chunk, end, or error back to the
   * request that produced it. Zero when the kind does not correlate.
   */
  correlation: number;
}

const VERSION = 1;
/** version + kind + float64 correlation id. */
const HEADER_BYTES = 10;

const KIND_VALUES = new Set<number>(Object.values(EnvelopeKind));

/** An ordinary application message, the default when no header is present. */
export function messageEnvelope(): Envelope {
  return { kind: EnvelopeKind.Message, correlation: 0 };
}

/**
 * Encode envelope metadata for transport alongside a payload.
 *
 * ```ts no_run
 * import { encodeEnvelope, EnvelopeKind } from 'internal:realm/envelope';
 *
 * const header = encodeEnvelope({ kind: EnvelopeKind.RpcResponse, correlation: 7 });
 * ```
 */
export function encodeEnvelope(envelope: Envelope): Uint8Array {
  const bytes = new Uint8Array(HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint8(0, VERSION);
  view.setUint8(1, envelope.kind);
  view.setFloat64(2, envelope.correlation, true);
  return bytes;
}

/**
 * Decode envelope metadata produced by `encodeEnvelope`.
 *
 * Returns an ordinary `Message` envelope for absent, truncated, or otherwise
 * unrecognised headers. A message whose header cannot be understood is treated
 * as application traffic rather than as a control signal, so a malformed or
 * future-versioned header can never be mistaken for a termination request or an
 * RPC response.
 *
 * ```ts no_run
 * import { decodeEnvelope } from 'internal:realm/envelope';
 *
 * const envelope = decodeEnvelope(header);
 * ```
 */
export function decodeEnvelope(header: Uint8Array | undefined): Envelope {
  if (header === undefined || header.byteLength < HEADER_BYTES) return messageEnvelope();
  const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
  if (view.getUint8(0) !== VERSION) return messageEnvelope();
  const kind = view.getUint8(1);
  if (!KIND_VALUES.has(kind)) return messageEnvelope();
  return { kind: kind as EnvelopeKindValue, correlation: view.getFloat64(2, true) };
}
