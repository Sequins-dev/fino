/**
 * Deferring elementwise work so a chain of it becomes one kernel.
 *
 * An elementwise operation reads its input, does a few instructions, and writes its
 * result — so a chain of four costs four launches and four round trips through memory
 * to do arithmetic that would fit in registers. Fusing them is the single largest
 * saving available to this engine, and roughly three quarters of the operations in a
 * training step are elementwise.
 *
 * Fusing means not launching yet, which is the whole difficulty. Dispatch is eager, so
 * an operation that does not run has to leave something behind that will run it when
 * anyone needs the values. That is what a *pending* tensor is: storage allocated, not
 * written, and an expression describing what belongs in it.
 *
 * The expression is backend-neutral. The framework knows nothing about kernels, so a
 * chain is described as steps over operands — a leaf tensor, an earlier step, or a
 * constant — and a backend that can fuse turns that into one kernel. A backend that
 * cannot simply never sees a chain, because the decision to defer is only taken when
 * one is available.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */
import type { ChainArg, ChainStep, EwOp, TensorDesc } from './backend.ts';
import type { Storage, Tensor } from './tensor.ts';

/**
 * Longest chain that will be built.
 *
 * A fused kernel holds one buffer binding per leaf, and the parameter block is finite;
 * beyond a certain depth the register pressure also stops paying. Reaching the limit
 * materialises and starts a new chain, which costs one launch rather than being wrong.
 */
const MAX_STEPS = 16;

/**
 * The most leaves a chain may bind.
 *
 * Kept below the eight-binding pipeline layout the GPU backends share, with one
 * reserved for the output.
 */
const MAX_LEAVES = 7;

/**
 * One operand a chain reads.
 *
 * The descriptor is taken when the chain is planned and the storage is retained, so the
 * chain can run even if the tensor it came from is disposed in the meantime — which
 * happens routinely, since a `tidy` scope closes over exactly these intermediates.
 */
export interface Leaf {
  tensor: Tensor;
  desc: TensorDesc;
  storage: Storage;
}

/** An elementwise computation that has not been run. */
export interface Pending {
  /** Steps in evaluation order; the last one produces the result. */
  steps: ChainStep[];
  /** Operands the steps read. */
  leaves: Leaf[];
  /**
   * Whether this expression has already been folded into another one.
   *
   * A pending tensor used twice would otherwise be computed twice — once inside each
   * consumer. Allowing it once and materialising afterwards bounds that at a single
   * duplicate, which is cheaper than the launch it saves.
   */
  inlined: boolean;
}

/**
 * Build the chain for one operation over its inputs.
 *
 * Returns null when the operation cannot join a chain, which the caller answers by
 * dispatching it normally. Refusing is always safe; the cases refused here are the
 * ones where fusing would change what is computed.
 */
export function planChain(
  op: EwOp,
  inputs: readonly Tensor[],
  scalar: number | null,
  scalarOnLeft: boolean,
  shape: readonly number[],
  capture: (tensor: Tensor) => Leaf,
  maxLeaves = MAX_LEAVES,
): Pending | null {
  const planned = plan(op, inputs, scalar, scalarOnLeft, shape, capture, maxLeaves);
  return planned;
}

/**
 * The planner proper, which takes a claim on each operand as it goes.
 *
 * Giving up partway therefore has to hand those claims back — a plan that bails after
 * capturing two of three operands would otherwise hold their memory forever, which is
 * a leak of exactly the shape a long training loop notices and nothing else does.
 *
 * @internal
 */
function plan(
  op: EwOp,
  inputs: readonly Tensor[],
  scalar: number | null,
  scalarOnLeft: boolean,
  shape: readonly number[],
  capture: (tensor: Tensor) => Leaf,
  maxLeaves: number,
): Pending | null {
  const steps: ChainStep[] = [];
  const leaves: Leaf[] = [];
  const abandon = (): null => {
    for (const leaf of leaves) leaf.storage.release();
    return null;
  };

  /** Fold an input in, inlining its own chain when it has one to spare. */
  const operand = (tensor: Tensor): ChainArg | null => {
    const pending = tensor.pending;
    if (pending && !pending.inlined && steps.length + pending.steps.length <= MAX_STEPS) {
      // Renumber the borrowed steps: its leaves land after ours, and its step
      // references shift by however many steps are already here.
      const leafBase = leaves.length;
      const stepBase = steps.length;
      if (leafBase + pending.leaves.length > maxLeaves) return null;
      // Copied rather than moved: the tensor being borrowed from keeps its own
      // expression and its own claim on these operands. The descriptor is copied rather
      // than taken afresh, because the tensor it came from may already be disposed —
      // the storage is alive precisely because a chain is holding it.
      for (const leaf of pending.leaves) {
        leaf.storage.retain();
        leaves.push({ tensor: leaf.tensor, desc: leaf.desc, storage: leaf.storage });
      }
      for (const step of pending.steps) {
        steps.push({
          op: step.op,
          args: step.args.map((arg) =>
            arg.from === 'input'
              ? { from: 'input', index: arg.index + leafBase }
              : arg.from === 'step'
                ? { from: 'step', index: arg.index + stepBase }
                : arg,
          ),
        });
      }
      pending.inlined = true;
      return { from: 'step', index: steps.length - 1 };
    }
    // A materialised tensor, or one whose expression is already spoken for.
    const existing = leaves.findIndex((leaf) => leaf.tensor === tensor);
    if (existing >= 0) return { from: 'input', index: existing };
    if (leaves.length >= maxLeaves) return null;
    leaves.push(capture(tensor));
    return { from: 'input', index: leaves.length - 1 };
  };

  const args: ChainArg[] = [];
  for (const input of inputs) {
    // Only same-shaped operands fuse. A broadcast would need the kernel to index its
    // operands differently from one another, which the chain does not describe.
    if (input.rank !== shape.length || !input.shape.every((d, i) => d === shape[i])) {
      return abandon();
    }
    const arg = operand(input);
    if (!arg) return abandon();
    args.push(arg);
  }
  if (scalar !== null) {
    const constant: ChainArg = { from: 'scalar', value: scalar };
    if (scalarOnLeft) args.unshift(constant);
    else args.push(constant);
  }

  steps.push({ op, args });
  if (steps.length > MAX_STEPS) return abandon();
  return { steps, leaves, inlined: false };
}

/**
 * A stable description of a chain's shape, ignoring the values of its constants.
 *
 * Two chains differing only in a constant share a kernel, because a constant is a
 * parameter rather than something compiled in.
 */
export function chainKey(steps: readonly ChainStep[]): string {
  // Identifier-safe, because it becomes part of a kernel's name as well as its cache
  // key. Operation names contain no underscores, so single underscores between operands
  // and double between steps stay unambiguous — two different chains cannot produce the
  // same key, which matters because the key is what decides a cache hit.
  return steps
    .map(
      (step) =>
        [step.op, ...step.args.map((arg) => (arg.from === 'scalar' ? 'k' : `${arg.from[0]}${arg.index}`))].join(
          '_',
        ),
    )
    .join('__');
}

/** Every constant in a chain, in the order a kernel binds them. */
export function chainScalars(steps: readonly ChainStep[]): number[] {
  const out: number[] = [];
  for (const step of steps) {
    for (const arg of step.args) if (arg.from === 'scalar') out.push(arg.value);
  }
  return out;
}
