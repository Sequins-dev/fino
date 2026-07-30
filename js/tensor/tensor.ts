/**
 * The `Tensor` handle and its storage lifecycle.
 *
 * Device memory is invisible to the garbage collector: an eight-byte JS handle
 * can pin gigabytes the collector cannot see or account for. Disposal is
 * therefore explicit and documented as the norm rather than as an optimisation,
 * with a finalizer only as a backstop that *counts* leaks so they are measurable.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */
import type { DType } from './dtype.ts';
import { DTYPE_BYTES } from './dtype.ts';
import type { Device, DeviceBackend, Stream, TensorDesc } from './backend.ts';
import { backendFor, formatDevice } from './backend.ts';
import type { PooledBuffer } from './pool.ts';
import { poolFor } from './pool.ts';
import { contiguousStrides, numel } from './shape.ts';
import type { ValueId } from './graph.ts';
import type { GradNode } from './autograd.ts';

/**
 * Reference-counted device allocation behind one or more tensors.
 *
 * `reshape` and `detach` share storage, so the count is what decides when a
 * buffer returns to the pool.
 */
export class Storage {
  readonly backend: DeviceBackend;
  readonly device: Device;
  pooled: PooledBuffer;
  #count = 1;
  #disposed = false;

  constructor(backend: DeviceBackend, device: Device, pooled: PooledBuffer) {
    this.backend = backend;
    this.device = device;
    this.pooled = pooled;
  }

  /** Live reference count. */
  get refCount(): number {
    return this.#count;
  }

  /** Whether the storage has been released. */
  get disposed(): boolean {
    return this.#disposed;
  }

  /** Bytes the allocation spans. */
  get byteLength(): number {
    return this.pooled.bytes;
  }

  /** Take a reference. */
  retain(): void {
    if (this.#disposed) throw new Error('cannot retain disposed tensor storage');
    this.#count++;
  }

  /** Drop a reference, returning the buffer to the pool at zero. */
  release(): void {
    if (this.#disposed) return;
    this.#count--;
    if (this.#count > 0) return;
    this.#disposed = true;
    poolFor(this.backend).give(this.pooled);
  }

  /**
   * Drop a reference on behalf of the finalizer.
   *
   * Exactly one reference, never more. Storage is shared — a contiguous `reshape`
   * and a `detach` both alias it — so a collected handle must decrement like any
   * other. Forcing the count to one here would free the buffer out from under
   * every other live handle, which is a use-after-free that only shows up once the
   * collector happens to run.
   *
   * The leak is counted separately so it appears in pool statistics rather than
   * being cleaned up silently.
   */
  releaseLeaked(): void {
    if (this.#disposed) return;
    poolFor(this.backend).noteLeak();
    this.release();
  }
}

/**
 * Reclaims storage for tensors dropped without disposal.
 *
 * A backstop, not a strategy: it runs at the collector's discretion, which is
 * far too late for a training loop. Its real job is to keep the leak counter
 * honest. Follows the pattern in `js/globals/crypto.ts`.
 *
 * @internal
 */
const finalizer = new FinalizationRegistry<Storage>((storage) => {
  storage.releaseLeaked();
});

/**
 * Stack of open `tidy` scopes.
 *
 * @internal
 */
const scopes: Set<Tensor>[] = [];

/**
 * Tensors escaping the innermost scope.
 *
 * @internal
 */
const kept = new Set<Tensor>();

/** Options for constructing a tensor from existing storage. */
export interface TensorInit {
  storage: Storage;
  shape: readonly number[];
  dtype: DType;
  /** Offset into the storage, in elements. */
  offset?: number;
  /** Strides in elements; defaults to contiguous for the shape. */
  strides?: readonly number[];
  valueId: ValueId;
  requiresGrad?: boolean;
  gradFn?: GradNode | null;
}

/**
 * A tensor.
 *
 * Operation methods live in `ops.ts` and are attached to the prototype at import
 * so this module stays free of the op registry, which needs `Tensor` itself.
 */
export class Tensor {
  readonly dtype: DType;
  readonly shape: readonly number[];
  readonly device: Device;

  /**
   * Whether gradients flow to this tensor.
   *
   * Mutable on leaves — a parameter becomes trainable by being marked so — but
   * setting it on a non-leaf is refused, since the graph edge already decides.
   */
  #requiresGrad: boolean;

  /** Accumulated gradient, populated by `backward()`. */
  grad: Tensor | null = null;

  /**
   * Gradient edge, or `null` for a leaf.
   *
   * @internal
   */
  gradFn: GradNode | null;

  /**
   * @internal
   */
  storage: Storage;

  /**
   * @internal
   */
  offset: number;

  /**
   * Strides in elements. Not public: layout is backend-owned.
   *
   * @internal
   */
  strides: readonly number[];

  /**
   * Graph value this tensor names.
   *
   * @internal
   */
  valueId: ValueId;

  #disposed = false;

  constructor(init: TensorInit) {
    this.storage = init.storage;
    this.shape = Object.freeze([...init.shape]);
    this.dtype = init.dtype;
    this.device = init.storage.device;
    this.offset = init.offset ?? 0;
    this.strides = init.strides ? Object.freeze([...init.strides]) : Object.freeze(contiguousStrides(init.shape));
    this.valueId = init.valueId;
    this.#requiresGrad = init.requiresGrad ?? false;
    this.gradFn = init.gradFn ?? null;
    finalizer.register(this, this.storage, this);
    const scope = scopes[scopes.length - 1];
    if (scope) scope.add(this);
  }

  /** Number of elements. */
  get size(): number {
    return numel(this.shape);
  }

  /** Number of axes. */
  get rank(): number {
    return this.shape.length;
  }

  /** Bytes the elements occupy. */
  get byteLength(): number {
    return this.size * DTYPE_BYTES[this.dtype];
  }

  /** Whether gradients flow to this tensor. */
  get requiresGrad(): boolean {
    return this.#requiresGrad;
  }

  set requiresGrad(value: boolean) {
    if (this.gradFn !== null && value !== this.#requiresGrad) {
      throw new Error(
        'requiresGrad cannot be changed on a tensor produced by an operation; call detach() first',
      );
    }
    this.#requiresGrad = value;
  }

  /** Whether this tensor is a graph leaf. */
  get isLeaf(): boolean {
    return this.gradFn === null;
  }

  /** Whether the tensor has been disposed. */
  get disposed(): boolean {
    return this.#disposed;
  }

  /** Whether the elements are contiguous in storage. */
  get contiguous(): boolean {
    const expected = contiguousStrides(this.shape);
    return this.strides.every((s, i) => s === expected[i]);
  }

  /** The backend serving this tensor. */
  get backend(): DeviceBackend {
    return backendFor(this.device);
  }

  /**
   * Throw if the tensor has been disposed.
   *
   * @internal
   */
  check(): void {
    if (this.#disposed || this.storage.disposed) {
      throw new Error(
        `tensor ${formatShapeAndType(this)} has been disposed; it cannot be used again`,
      );
    }
  }

  /**
   * Build the backend-facing descriptor.
   *
   * Fills a caller-supplied object so dispatch can reuse one per operand rather
   * than allocating. Backends must not retain it past the call.
   *
   * @internal
   */
  describe(into: TensorDesc): TensorDesc {
    this.check();
    into.buffer = this.storage.pooled.buffer;
    into.dtype = this.dtype;
    into.shape = this.shape;
    into.strides = this.strides;
    into.offset = this.offset;
    return into;
  }

  /**
   * A new handle over the same storage.
   *
   * @internal
   */
  alias(init: Omit<TensorInit, 'storage'>): Tensor {
    this.storage.retain();
    return new Tensor({ ...init, storage: this.storage });
  }

  /** Release this tensor's claim on its storage. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    finalizer.unregister(this);
    this.storage.release();
    const scope = scopes[scopes.length - 1];
    scope?.delete(this);
  }

  /** Support `using`. */
  [Symbol.dispose](): void {
    this.dispose();
  }

  /** Describe the tensor without reading its values. */
  toString(): string {
    return `Tensor(${formatShapeAndType(this)}, device=${formatDevice(this.device)}${
      this.requiresGrad ? ', requiresGrad' : ''
    })`;
  }
}

/**
 * Shape and dtype, for messages.
 *
 * @internal
 */
function formatShapeAndType(t: Tensor): string {
  return `[${t.shape.join(', ')}] ${t.dtype}`;
}

/**
 * Allocate storage for a new tensor.
 *
 * @internal
 */
export function allocStorage(
  backend: DeviceBackend,
  device: Device,
  bytes: number,
  stream: Stream,
): Storage {
  return new Storage(backend, device, poolFor(backend).take(bytes, stream));
}

/**
 * Run `fn`, disposing every tensor created inside it.
 *
 * Tensors returned from `fn`, or marked with {@link keep}, survive. This is the
 * documented way to write anything loop-shaped, because the alternative is
 * tracking every intermediate by hand.
 */
export function tidy<T>(fn: () => T): T {
  const scope = new Set<Tensor>();
  scopes.push(scope);
  let result: T;
  try {
    result = fn();
  } finally {
    scopes.pop();
  }
  const survivors = new Set<Tensor>();
  collectTensors(result, survivors);
  for (const t of kept) survivors.add(t);
  kept.clear();
  for (const t of scope) {
    if (!survivors.has(t)) t.dispose();
  }
  // A survivor created in this scope belongs to the enclosing one now.
  const parent = scopes[scopes.length - 1];
  if (parent) {
    for (const t of scope) if (survivors.has(t)) parent.add(t);
  }
  return result;
}

/**
 * Exempt a tensor from the innermost {@link tidy} scope.
 *
 * A no-op when no scope is open, so the exemption set cannot accumulate entries
 * that nothing will ever clear.
 */
export function keep<T extends Tensor>(tensor: T): T {
  if (scopes.length > 0) kept.add(tensor);
  return tensor;
}

/**
 * Find tensors reachable from a returned value.
 *
 * Walks arrays and plain objects one level deep, which covers the shapes a
 * function actually returns without turning into a general object graph walk.
 *
 * @internal
 */
function collectTensors(value: unknown, into: Set<Tensor>): void {
  if (value instanceof Tensor) {
    into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectTensors(item, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      if (item instanceof Tensor) into.add(item);
    }
  }
}

/** Whether a `tidy` scope is open. */
export function inScope(): boolean {
  return scopes.length > 0;
}
