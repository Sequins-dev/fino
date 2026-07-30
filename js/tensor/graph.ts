/**
 * `fino:tensor/graph` — the recorded execution graph.
 *
 * **Experimental.** Public because it is the seam where compilation, hardware
 * lowering, and interchange all attach: a fusion pass, capture/replay, lowering
 * to a fixed-function accelerator's graph API, ONNX export, and visualisation all
 * need to read it. Its stability gate is the same as
 * `fino:tensor/backend`'s (`specs/tensor-contract.md` §1).
 *
 * This is a *recording with a documented shape*, not a compiler IR. Every
 * dispatched operation appends a node, forward and backward alike.
 *
 * ## What it deliberately does not hold
 *
 * Nodes carry value ids, shapes, dtypes, and attributes — never tensor
 * references. Recording therefore never keeps device memory alive; only user
 * handles and autodiff's saved tensors do that. Without this property a
 * long-running recording and tight memory would be mutually exclusive.
 */
import type { DType } from './dtype.ts';
import type { Device, OpAttrs, OpKind } from './backend.ts';
import { formatDevice } from './backend.ts';

/** Identifies one immutable tensor value. Values are single-assignment. */
export type ValueId = number;

/** Identifies one node in a recording. */
export type NodeId = number;

/** A node, materialised on demand from the recording's columnar storage. */
export interface GraphNode {
  readonly id: NodeId;
  /** Stable operation name. */
  readonly op: OpKind;
  readonly inputs: readonly ValueId[];
  readonly outputs: readonly ValueId[];
  /** JSON-representable attributes: axes, scalar operands, RNG keys. */
  readonly attrs: Readonly<OpAttrs> | null;
  /** Output shapes as recorded. */
  readonly shapes: readonly (readonly number[])[];
  /** Output dtypes as recorded. */
  readonly dtypes: readonly DType[];
  readonly device: Device;
}

/** A contiguous span of a recording. */
export interface GraphView {
  /** Nodes in the span, in dispatch order. */
  nodes(): IterableIterator<GraphNode>;
  /** Number of nodes. */
  readonly length: number;
  /** Content hash of the span. */
  hash(): string;
}

/** A step boundary, returned by {@link GraphRecording.markStep}. */
export interface StepMark {
  readonly node: NodeId;
  readonly hash: string;
}

/** FNV-1a 64 offset basis. */
const FNV_BASIS = 0xcbf29ce484222325n;

/** FNV-1a 64 prime. */
const FNV_PRIME = 0x100000001b3n;

/** 2^64 - 1. */
const MASK64 = 0xffffffffffffffffn;

/**
 * Fold a 64-bit hash into a running hash.
 *
 * @internal
 */
function foldHash(hash: bigint, value: bigint): bigint {
  let h = hash;
  let v = value;
  for (let i = 0; i < 8; i++) {
    h = ((h ^ (v & 0xffn)) * FNV_PRIME) & MASK64;
    v >>= 8n;
  }
  return h;
}

/**
 * Fold one integer into a running hash.
 *
 * @internal
 */
function foldInt(hash: bigint, value: number): bigint {
  let h = hash;
  let v = BigInt(value >>> 0);
  for (let i = 0; i < 4; i++) {
    h = ((h ^ (v & 0xffn)) * FNV_PRIME) & MASK64;
    v >>= 8n;
  }
  return h;
}

/**
 * Fold a string into a running hash.
 *
 * @internal
 */
function foldText(hash: bigint, text: string): bigint {
  let h = hash;
  for (let i = 0; i < text.length; i++) {
    h = ((h ^ BigInt(text.charCodeAt(i) & 0xff)) * FNV_PRIME) & MASK64;
  }
  return h;
}

/**
 * Numeric index for each dtype, so hashing does not depend on string identity.
 *
 * @internal
 */
const DTYPE_INDEX: Readonly<Record<DType, number>> = {
  bool: 0,
  u8: 1,
  i32: 2,
  i64: 3,
  f16: 4,
  bf16: 5,
  f32: 6,
  f64: 7,
};

/**
 * A recorded graph.
 *
 * Stored column-wise so appending a node costs a few array pushes rather than an
 * object allocation. `GraphNode` views are materialised only when a consumer
 * actually reads one, which for a training loop is never.
 */
export class GraphRecording {
  #ops: OpKind[] = [];
  #inputOffsets: number[] = [0];
  #inputs: ValueId[] = [];
  #outputOffsets: number[] = [0];
  #outputs: ValueId[] = [];
  #attrs: (OpAttrs | null)[] = [];
  #shapes: (readonly number[])[][] = [];
  #dtypes: DType[][] = [];
  #devices: Device[] = [];

  /**
   * Running content hash, folded per append.
   *
   * @internal
   */
  #hash = FNV_BASIS;

  /**
   * Standalone hash of each node, folded from the basis over that node alone.
   *
   * A span's hash folds these in order. Deriving it by combining two running-hash
   * snapshots would be wrong: FNV is not a group, so the difference between two
   * states does not identify the nodes between them.
   *
   * @internal
   */
  #nodeHash: bigint[] = [];

  #nextValue: ValueId = 0;
  #producer = new Map<ValueId, NodeId>();
  #stepMarks: StepMark[] = [];

  /**
   * Nodes dropped from the front by {@link truncateBefore}.
   *
   * Node ids stay stable across truncation, so consumers holding an id do not
   * silently start reading a different node.
   *
   * @internal
   */
  #dropped = 0;

  /** Soft cap before warning about unbounded growth. */
  #softCap: number;

  /**
   * Whether the growth warning has already been emitted.
   *
   * @internal
   */
  #warned = false;

  constructor(options: { softCap?: number } = {}) {
    this.#softCap = options.softCap ?? 1_000_000;
  }

  /** Number of nodes recorded, including any since dropped. */
  get length(): number {
    return this.#dropped + this.#ops.length;
  }

  /** Lowest node id still retained. */
  get firstNode(): NodeId {
    return this.#dropped;
  }

  /** Allocate a value id. */
  nextValue(): ValueId {
    return this.#nextValue++;
  }

  /**
   * Append a node.
   *
   * Returns its id. Output value ids are allocated by the caller, because
   * dispatch needs them before the node exists.
   */
  append(
    op: OpKind,
    inputs: readonly ValueId[],
    outputs: readonly ValueId[],
    attrs: OpAttrs | null,
    shapes: readonly (readonly number[])[],
    dtypes: readonly DType[],
    device: Device,
  ): NodeId {
    const id = this.length;
    this.#ops.push(op);
    for (const v of inputs) this.#inputs.push(v);
    this.#inputOffsets.push(this.#inputs.length);
    for (const v of outputs) this.#outputs.push(v);
    this.#outputOffsets.push(this.#outputs.length);
    this.#attrs.push(attrs);
    this.#shapes.push(shapes as (readonly number[])[]);
    this.#dtypes.push(dtypes as DType[]);
    this.#devices.push(device);
    for (const v of outputs) this.#producer.set(v, id);

    // Each node gets a standalone hash so any span can be hashed by folding the
    // nodes it contains.
    const nodeHash = this.#foldNode(FNV_BASIS, op, inputs, attrs, shapes, dtypes, device);
    this.#nodeHash.push(nodeHash);
    this.#hash = foldHash(this.#hash, nodeHash);

    if (this.#ops.length > this.#softCap && !this.#warned) {
      this.#warned = true;
      console.warn(
        `fino:tensor graph recording holds ${this.#ops.length} nodes without a step boundary; ` +
          'call markStep() once per training step, or reset() when recording is not needed',
      );
    }
    return id;
  }

  /**
   * Fold one node into a hash.
   *
   * Input value ids are folded as *offsets back* from the current node rather
   * than absolutely, so two structurally identical training steps hash equal
   * even though their value ids differ. That equality is what future
   * capture/replay keys on.
   *
   * @internal
   */
  #foldNode(
    hash: bigint,
    op: OpKind,
    inputs: readonly ValueId[],
    attrs: OpAttrs | null,
    shapes: readonly (readonly number[])[],
    dtypes: readonly DType[],
    device: Device,
  ): bigint {
    let h = foldText(hash, op);
    h = foldInt(h, inputs.length);
    for (const v of inputs) {
      const producer = this.#producer.get(v);
      // Distance to the producing node, or a sentinel for a graph input.
      h = foldInt(h, producer === undefined ? 0xffffffff : this.length - producer);
    }
    for (const shape of shapes) {
      h = foldInt(h, shape.length);
      for (const d of shape) h = foldInt(h, d);
    }
    for (const dtype of dtypes) h = foldInt(h, DTYPE_INDEX[dtype]);
    h = foldText(h, formatDevice(device));
    if (attrs) {
      for (const name of Object.keys(attrs).sort()) {
        h = foldText(h, name);
        const value = attrs[name];
        if (typeof value === 'number') h = foldInt(h, Math.round(value * 1e6));
        else if (typeof value === 'boolean') h = foldInt(h, value ? 1 : 0);
        else if (typeof value === 'string') h = foldText(h, value);
        else for (const item of value!) h = foldInt(h, item);
      }
    }
    return h;
  }

  /**
   * Storage index for a node id.
   *
   * @internal
   */
  #slot(id: NodeId): number {
    const slot = id - this.#dropped;
    if (slot < 0) {
      throw new Error(`graph node ${id} has been dropped by a step boundary`);
    }
    if (slot >= this.#ops.length) throw new Error(`graph node ${id} does not exist`);
    return slot;
  }

  /** Read one node. */
  node(id: NodeId): GraphNode {
    const slot = this.#slot(id);
    return {
      id,
      op: this.#ops[slot]!,
      inputs: this.#inputs.slice(this.#inputOffsets[slot]!, this.#inputOffsets[slot + 1]!),
      outputs: this.#outputs.slice(this.#outputOffsets[slot]!, this.#outputOffsets[slot + 1]!),
      attrs: this.#attrs[slot],
      shapes: this.#shapes[slot]!,
      dtypes: this.#dtypes[slot]!,
      device: this.#devices[slot]!,
    };
  }

  /** Iterate retained nodes in dispatch order. */
  *nodes(): IterableIterator<GraphNode> {
    for (let slot = 0; slot < this.#ops.length; slot++) {
      yield this.node(this.#dropped + slot);
    }
  }

  /** Iterate retained nodes. */
  [Symbol.iterator](): IterableIterator<GraphNode> {
    return this.nodes();
  }

  /** The node that produced a value, or `null` for a graph input. */
  producerOf(value: ValueId): NodeId | null {
    return this.#producer.get(value) ?? null;
  }

  /** Nodes consuming a value. */
  consumersOf(value: ValueId): NodeId[] {
    const out: NodeId[] = [];
    for (let slot = 0; slot < this.#ops.length; slot++) {
      const from = this.#inputOffsets[slot]!;
      const to = this.#inputOffsets[slot + 1]!;
      for (let i = from; i < to; i++) {
        if (this.#inputs[i] === value) {
          out.push(this.#dropped + slot);
          break;
        }
      }
    }
    return out;
  }

  /** Content hash of the whole recording. */
  hash(): string {
    return this.#hash.toString(16).padStart(16, '0');
  }

  /**
   * A span of the recording, as a read-only view.
   *
   * `to` is exclusive and defaults to the end.
   */
  slice(from: NodeId, to?: NodeId): GraphView {
    const start = Math.max(from, this.#dropped);
    const end = to ?? this.length;
    if (end < start) throw new Error(`invalid graph span ${from}..${to}`);
    const recording = this;
    const hashes = this.#nodeHash;
    const dropped = this.#dropped;
    return {
      get length() {
        return end - start;
      },
      *nodes() {
        for (let id = start; id < end; id++) yield recording.node(id);
      },
      hash() {
        let h = FNV_BASIS;
        for (let id = start; id < end; id++) h = foldHash(h, hashes[id - dropped]!);
        return h.toString(16).padStart(16, '0');
      },
    };
  }

  /**
   * Record a step boundary.
   *
   * Optimizers call this once per step. It gives the recording a place to
   * truncate and is the hash a future capture/replay pass compares.
   */
  markStep(): StepMark {
    const mark: StepMark = { node: this.length, hash: this.hash() };
    this.#stepMarks.push(mark);
    if (this.#stepMarks.length > 3) this.#stepMarks.shift();
    return mark;
  }

  /** The most recent step boundaries, oldest first. */
  stepMarks(): readonly StepMark[] {
    return this.#stepMarks;
  }

  /**
   * Hash of the span between the last two step boundaries.
   *
   * Two consecutive steps of a shape-stable training loop produce the same value,
   * which is the signal that the step could be captured and replayed.
   */
  lastStepHash(): string | null {
    if (this.#stepMarks.length < 2) return null;
    const [previous, latest] = this.#stepMarks.slice(-2);
    return this.slice(previous!.node, latest!.node).hash();
  }

  /**
   * Drop nodes before `id`.
   *
   * Node ids stay stable; reading a dropped node throws rather than returning
   * the wrong one.
   */
  truncateBefore(id: NodeId): void {
    const count = Math.min(id - this.#dropped, this.#ops.length);
    if (count <= 0) return;
    this.#ops.splice(0, count);
    this.#attrs.splice(0, count);
    this.#shapes.splice(0, count);
    this.#dtypes.splice(0, count);
    this.#devices.splice(0, count);
    this.#nodeHash.splice(0, count);
    const inputCut = this.#inputOffsets[count]!;
    this.#inputs.splice(0, inputCut);
    this.#inputOffsets = this.#inputOffsets.slice(count).map((o) => o - inputCut);
    const outputCut = this.#outputOffsets[count]!;
    this.#outputs.splice(0, outputCut);
    this.#outputOffsets = this.#outputOffsets.slice(count).map((o) => o - outputCut);
    this.#dropped += count;
    for (const [value, node] of this.#producer) {
      if (node < this.#dropped) this.#producer.delete(value);
    }
  }

  /** Discard everything recorded so far. */
  reset(): void {
    this.#ops.length = 0;
    this.#inputs.length = 0;
    this.#inputOffsets = [0];
    this.#outputs.length = 0;
    this.#outputOffsets = [0];
    this.#attrs.length = 0;
    this.#shapes.length = 0;
    this.#dtypes.length = 0;
    this.#devices.length = 0;
    this.#nodeHash.length = 0;
    this.#producer.clear();
    this.#stepMarks.length = 0;
    this.#dropped = 0;
    this.#hash = FNV_BASIS;
    this.#warned = false;
  }
}

/**
 * The recording dispatch appends to.
 *
 * One per process: a graph spans devices by design, since partitioning across
 * devices of different capability is the framework's job.
 *
 * @internal
 */
let current = new GraphRecording();

/** The active recording. */
export function currentGraph(): GraphRecording {
  return current;
}

/** Replace the active recording, returning the previous one. */
export function setCurrentGraph(recording: GraphRecording): GraphRecording {
  const previous = current;
  current = recording;
  return previous;
}

// -- partitioning -------------------------------------------------------------

/** Minimal backend surface partitioning needs. */
export interface PartitionTarget {
  /** Name used in diagnostics and in the returned partitions. */
  readonly name: string;
  /** Whether this target can run a node. */
  supports(node: GraphNode): boolean;
  /** Whether this target is the universal fallback. */
  readonly fallback?: boolean;
}

/** A run of nodes assigned to one target. */
export interface Partition {
  /** Target name. */
  target: string;
  /** Nodes in dispatch order. */
  nodes: NodeId[];
  /** Values entering the partition from outside it. */
  inputs: ValueId[];
  /** Values the partition produces that are read outside it. */
  outputs: ValueId[];
}

/**
 * Split a recording into device-executable runs.
 *
 * Walks in dispatch order, assigns each node to the first target that accepts it,
 * and merges adjacent nodes with the same target. There is no cost model: v1
 * placement is correctness-driven, and a run is never assigned to a target that
 * cannot execute every node in it.
 *
 * Fixed-function devices support only a subset of operations, shapes, and
 * dtypes, which is why this belongs to the framework rather than to any backend —
 * it is hardware-agnostic, and the recording is the only thing that sees the
 * whole computation.
 */
export function partition(
  view: GraphView,
  targets: readonly PartitionTarget[],
): Partition[] {
  if (targets.length === 0) throw new Error('partitioning needs at least one target');
  const nodes = [...view.nodes()];
  const assignment = new Map<NodeId, string>();
  const produced = new Map<ValueId, NodeId>();

  for (const node of nodes) {
    const target = targets.find((t) => t.supports(node)) ?? targets.find((t) => t.fallback);
    if (!target) {
      throw new Error(
        `no target can execute '${node.op}' and no fallback target is registered`,
      );
    }
    assignment.set(node.id, target.name);
    for (const out of node.outputs) produced.set(out, node.id);
  }

  const runs: Partition[] = [];
  for (const node of nodes) {
    const target = assignment.get(node.id)!;
    const last = runs[runs.length - 1];
    if (last && last.target === target) {
      last.nodes.push(node.id);
    } else {
      runs.push({ target, nodes: [node.id], inputs: [], outputs: [] });
    }
  }

  // Crossing values: an input whose producer is outside this run, or an output
  // read by a node in another run. These are where transfers go.
  const runOf = new Map<NodeId, number>();
  runs.forEach((run, index) => {
    for (const id of run.nodes) runOf.set(id, index);
  });
  const byId = new Map(nodes.map((n) => [n.id, n]));

  runs.forEach((run, index) => {
    const owned = new Set<ValueId>();
    for (const id of run.nodes) for (const out of byId.get(id)!.outputs) owned.add(out);
    const inputs = new Set<ValueId>();
    for (const id of run.nodes) {
      for (const input of byId.get(id)!.inputs) {
        if (!owned.has(input)) inputs.add(input);
      }
    }
    const outputs = new Set<ValueId>();
    for (const value of owned) {
      for (const consumer of nodes) {
        if (runOf.get(consumer.id) === index) continue;
        if (consumer.inputs.includes(value)) {
          outputs.add(value);
          break;
        }
      }
    }
    run.inputs = [...inputs].sort((a, b) => a - b);
    run.outputs = [...outputs].sort((a, b) => a - b);
  });

  return runs;
}
