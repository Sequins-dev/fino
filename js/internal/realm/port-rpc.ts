/**
* internal:realm/port-rpc — the one request/response engine for port channels.
*
* Every cross-realm RPC framing is the same machine: a monotonic request id,
* a pending-map of resolvers, and a message listener that correlates replies.
* This module owns that machine once. A `WireCodec` maps the machine onto a
* concrete envelope family, so existing wire formats stay byte-identical
* while their client sides share one implementation.
*
* Zero imports by design: this sits below `internal:parent-rpc` and
* `internal:realm/transport-port` in the bootstrap order and must never form
* a cycle with them.
*
* @internal
*/

/** A decoded incoming envelope, normalized across codecs. */
export type Decoded =
  | { kind: 'res'; id: number; result: unknown }
  | { kind: 'err'; id: number; error: string | Error }
  | { kind: 'chunk'; id: number; chunk: unknown }
  | { kind: 'end'; id: number };

export interface WireCodec {
  /** Build the outgoing request envelope for `id` around `head`. */
  encodeReq(id: number, head: Record<string, unknown>): unknown;
  /** Decode an incoming message, or `null` when it is not this codec's. */
  decode(msg: Record<string, unknown>): Decoded | null;
}

/** The default `__rpc_*` envelope family used by facade RPC. */
const RPC_CODEC: WireCodec = {
  encodeReq(id, head) {
    return { __rpc_req: true, reqId: id, ...head };
  },
  decode(msg) {
    const id = msg['reqId'] as number;
    if (msg['__rpc_res'] === true) {
      if (typeof msg['error'] === 'string') return { kind: 'err', id, error: msg['error'] };
      return { kind: 'res', id, result: msg['result'] };
    }
    if (msg['__rpc_chunk'] === true) return { kind: 'chunk', id, chunk: msg['chunk'] };
    if (msg['__rpc_end'] === true) return { kind: 'end', id };
    if (msg['__rpc_err'] === true) return { kind: 'err', id, error: String(msg['error']) };
    return null;
  }
};

/** Async chunk queue buffering a stream until its consumer iterates. */
class AsyncChunkQueue {
  #queue: unknown[] = [];
  #waiters: Array<() => void> = [];
  #done = false;
  #error: string | null = null;

  push(chunk: unknown): void {
    this.#queue.push(chunk);
    this.#waiters.shift()?.();
  }

  end(): void {
    this.#done = true;
    for (const wake of this.#waiters.splice(0)) wake();
  }

  fail(message: string): void {
    this.#error = message;
    this.#done = true;
    for (const wake of this.#waiters.splice(0)) wake();
  }

  [Symbol.asyncIterator](): AsyncIterator<unknown> {
    const self = this;
    return { async next(): Promise<IteratorResult<unknown>> {
      while (self.#queue.length === 0 && !self.#done) {
        await new Promise<void>((resolve) => self.#waiters.push(resolve));
      }
      if (self.#queue.length > 0) return { value: self.#queue.shift()!, done: false };
      if (self.#error !== null) throw new Error(self.#error);
      return { value: undefined as unknown, done: true };
    } };
  }
}

/**
* A write-stream handle opened by `callSink`: fire-and-forget chunks flowing
* to the peer, settled by the peer's terminal response. Uses the `__rpc_send_*`
* envelope family (sinks exist only on the facade framing).
*/
export class WriteSink {
  /** Result returned by the peer's sink handler. */
  readonly result: Promise<unknown>;
  readonly #id: number;
  readonly #send: (msg: unknown) => void;
  #resolve!: (v: unknown) => void;
  #reject!: (e: Error) => void;

  constructor(id: number, send: (msg: unknown) => void) {
    this.#id = id;
    this.#send = send;
    this.result = new Promise<unknown>((resolve, reject) => {
      this.#resolve = resolve;
      this.#reject = reject;
    });
  }

  /** Push a chunk; no per-chunk acknowledgement or backpressure. */
  write(chunk: unknown): void {
    this.#send({ __rpc_send_chunk: true, reqId: this.#id, chunk });
  }

  /** Signal end-of-stream; the peer may still settle `result`. */
  close(): void {
    this.#send({ __rpc_send_end: true, reqId: this.#id });
  }

  [Symbol.dispose](): void {
    this.close();
  }

  /** Abort with an error; `result` settles when the peer responds. */
  abort(error: string): void {
    this.#send({ __rpc_send_err: true, reqId: this.#id, error });
  }

  /** @internal Settle from the dispatch path. */
  _resolve(value: unknown): void {
    this.#resolve(value);
  }

  /** @internal Settle from the dispatch path. */
  _reject(error: string): void {
    this.#reject(new Error(error));
  }
}

interface PortRpcOptions {
  send(msg: unknown): void;
  codec?: WireCodec;
  /** Hook applied to scalar results before resolving (handle-proxy wrapping). */
  wrapResult?(result: unknown): unknown;
}

type PendingEntry =
  | { kind: 'scalar'; resolve(v: unknown): void; reject(e: unknown): void }
  | { kind: 'stream'; queue: AsyncChunkQueue }
  | { kind: 'sink'; sink: WriteSink };

export class PortRpc {
  #nextId = 0;
  #pending = new Map<number, PendingEntry>();
  #send: (msg: unknown) => void;
  #codec: WireCodec;
  #wrapResult: ((result: unknown) => unknown) | null;

  constructor(options: PortRpcOptions) {
    this.#send = options.send;
    this.#codec = options.codec ?? RPC_CODEC;
    this.#wrapResult = options.wrapResult ?? null;
  }

  /** Send a request and resolve with its correlated response. */
  call(head: Record<string, unknown>): Promise<unknown> {
    return this.callWithId(head).promise;
  }

  /** `call`, but exposing the allocated id (for caller-side terminal races). */
  callWithId(head: Record<string, unknown>): { id: number; promise: Promise<unknown> } {
    const id = this.#nextId++;
    const promise = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { kind: 'scalar', resolve, reject });
      this.#send(this.#codec.encodeReq(id, head));
    });
    return { id, promise };
  }

  /** Send a request whose response is a chunk stream. */
  callStream(head: Record<string, unknown>): AsyncIterable<unknown> {
    const id = this.#nextId++;
    const queue = new AsyncChunkQueue();
    this.#pending.set(id, { kind: 'stream', queue });
    this.#send(this.#codec.encodeReq(id, head));
    return queue;
  }

  /** Open a write stream to the peer (`__rpc_send_*` family only). */
  callSink(head: Record<string, unknown>): WriteSink {
    const id = this.#nextId++;
    const sink = new WriteSink(id, this.#send);
    this.#pending.set(id, { kind: 'sink', sink });
    this.#send({ __rpc_send_start: true, reqId: id, ...head });
    return sink;
  }

  /**
  * Route one incoming message through the codec. Returns `true` when it was
  * consumed. Settle order matches the historical drain: a response settles a
  * pending scalar, else a sink; an error additionally falls through to a
  * stream (a handler that threw before yielding its first chunk).
  */
  dispatch(msg: unknown): boolean {
    if (msg === null || typeof msg !== 'object') return false;
    const decoded = this.#codec.decode(msg as Record<string, unknown>);
    if (decoded === null) return false;
    const entry = this.#pending.get(decoded.id);
    if (entry === undefined) return true;
    switch (decoded.kind) {
      case 'res': {
        if (entry.kind === 'scalar') {
          this.#pending.delete(decoded.id);
          entry.resolve(this.#wrapResult !== null ? this.#wrapResult(decoded.result) : decoded.result);
        } else if (entry.kind === 'sink') {
          this.#pending.delete(decoded.id);
          entry.sink._resolve(decoded.result);
        }
        return true;
      }
      case 'err': {
        this.#pending.delete(decoded.id);
        if (entry.kind === 'scalar') {
          entry.reject(typeof decoded.error === 'string' ? new Error(decoded.error) : decoded.error);
        } else {
          const message = typeof decoded.error === 'string' ? decoded.error : decoded.error.message;
          if (entry.kind === 'sink') entry.sink._reject(message);
          else entry.queue.fail(message);
        }
        return true;
      }
      case 'chunk':
        if (entry.kind === 'stream') entry.queue.push(decoded.chunk);
        return true;
      case 'end':
        if (entry.kind === 'stream') {
          this.#pending.delete(decoded.id);
          entry.queue.end();
        }
        return true;
    }
  }

  /** Reject one pending scalar externally (terminal-race path). */
  fail(id: number, error: Error): boolean {
    const entry = this.#pending.get(id);
    if (entry?.kind !== 'scalar') return false;
    this.#pending.delete(id);
    entry.reject(error);
    return true;
  }

  /** Reject everything outstanding (channel teardown). */
  rejectAll(reason: Error): void {
    for (const entry of this.#pending.values()) {
      if (entry.kind === 'scalar') entry.reject(reason);
      else if (entry.kind === 'sink') entry.sink._reject(reason.message);
      else entry.queue.fail(reason.message);
    }
    this.#pending.clear();
  }
}
