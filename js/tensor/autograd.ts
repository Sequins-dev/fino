/**
 * Reverse-mode automatic differentiation.
 *
 * The tape is ours and written in TypeScript, which means it is portable across
 * every backend including the reference oracle. That matters more than it
 * sounds: it lets `gradCheck` validate the tape against finite differences on the
 * reference backend, so a gradient bug and a kernel bug can be told apart
 * instead of being diagnosed together.
 *
 * Backward is just more eager dispatch. It enqueues ordinary operations on the
 * same stream and never blocks, so its overhead is dispatch cost while kernel
 * time dominates.
 *
 * v1 excludes in-place operations (hence no version counters), higher-order
 * gradients, double backward, and distributed autograd.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */
import type { OpAttrs } from './backend.ts';
import type { OpSpec } from './ops/registry.ts';
import type { Tensor } from './tensor.ts';
import { keep as keepInScope } from './tensor.ts';

/**
 * One edge of the gradient graph.
 *
 * Holds saved tensors strongly, which is the only reason autodiff keeps device
 * memory alive; the recording itself holds none.
 */
export interface GradNode {
  /** The operation that produced the output. */
  spec: OpSpec;
  /** Inputs, for their gradient edges and `requiresGrad` flags. */
  inputs: readonly Tensor[];
  /** Tensors the rule asked to keep. */
  saved: readonly Tensor[];
  /** Attributes the forward operation ran with. */
  attrs: OpAttrs | null;
  /** Shapes and dtypes to restore cotangents to, per input. */
  inputShapes: readonly (readonly number[])[];
  /** Whether each input needs a cotangent. */
  needs: readonly boolean[];
  /** Whether the saved tensors have been released. */
  released: boolean;
}

/**
 * Whether recording is enabled.
 *
 * A plain stack rather than async-context state: recording is synchronous, so a
 * mode that survived an `await` would be wrong more often than right.
 *
 * @internal
 */
const modes: boolean[] = [true];

/** Whether gradients are currently being recorded. */
export function gradEnabled(): boolean {
  return modes[modes.length - 1]!;
}

/** Run `fn` without recording gradients. */
export function noGrad<T>(fn: () => T): T {
  modes.push(false);
  try {
    return fn();
  } finally {
    modes.pop();
  }
}

/** Run `fn` with gradient recording enabled. */
export function enableGrad<T>(fn: () => T): T {
  modes.push(true);
  try {
    return fn();
  } finally {
    modes.pop();
  }
}

/** Whether any input carries a gradient. */
export function anyRequiresGrad(inputs: readonly Tensor[]): boolean {
  for (const input of inputs) {
    if (input.requiresGrad || input.gradFn !== null) return true;
  }
  return false;
}

/**
 * Build the gradient edge for a dispatched operation.
 *
 * Returns `null` when nothing downstream could need it, which is the common case
 * during inference and keeps the hot path free of allocation.
 */
export function buildGradNode(
  spec: OpSpec,
  inputs: readonly Tensor[],
  output: Tensor,
): GradNode | null {
  if (!spec.vjp || !gradEnabled() || !anyRequiresGrad(inputs)) return null;
  const needs = inputs.map((input) => input.requiresGrad || input.gradFn !== null);
  const saved = spec.vjp.saves(inputs, output);
  for (const tensor of saved) tensor.storage.retain();
  return {
    spec,
    inputs,
    saved,
    attrs: null,
    inputShapes: inputs.map((input) => input.shape),
    needs,
    released: false,
  };
}

/**
 * Release a node's saved tensors.
 *
 * Called the moment backward has consumed them, which is what bounds peak
 * activation memory during a backward pass.
 *
 * @internal
 */
function releaseNode(node: GradNode): void {
  if (node.released) return;
  node.released = true;
  for (const tensor of node.saved) tensor.storage.release();
}

/** How `backward` behaves. */
export interface BackwardOptions {
  /**
   * Keep the gradient graph so `backward` can run again.
   *
   * Off by default: saved tensors are released as they are consumed, which is
   * what makes memory bounded.
   */
  retainGraph?: boolean;
}

/**
 * Accumulate gradients from `root` back to every leaf that requires them.
 *
 * `seed` is the cotangent of `root`; for a scalar loss it defaults to one.
 */
export function backward(
  root: Tensor,
  seed: Tensor | null,
  options: BackwardOptions = {},
): void {
  root.check();
  if (root.gradFn === null && !root.requiresGrad) {
    throw new Error('backward() called on a tensor that does not require gradients');
  }
  if (seed === null && root.size !== 1) {
    throw new Error(
      `backward() needs an explicit gradient for a non-scalar output of shape [${root.shape.join(', ')}]`,
    );
  }

  // Backward dispatches ordinary operations; recording gradients for them would
  // build a second-order graph, which v1 does not support.
  noGrad(() => {
    const cotangents = new Map<Tensor, Tensor>();
    cotangents.set(root, seed ?? onesLike(root));

    for (const node of topologicalOrder(root)) {
      const output = nodeOutput(node);
      const cotangent = output ? cotangents.get(output) : undefined;
      if (!cotangent) {
        // Nothing flowed into this output, so nothing flows out of it.
        if (!options.retainGraph) releaseNode(node);
        continue;
      }
      const grads = node.spec.vjp!.backward(cotangent, node.saved, node.attrs, node.needs);
      if (grads.length !== node.inputs.length) {
        throw new Error(
          `gradient rule for '${node.spec.name}' returned ${grads.length} cotangents for ${node.inputs.length} inputs`,
        );
      }
      for (let i = 0; i < node.inputs.length; i++) {
        const grad = grads[i];
        if (!grad || !node.needs[i]) continue;
        const input = node.inputs[i]!;
        // Reduce the cotangent back to the operand's shape here rather than in
        // each rule. A gradient flowing into a broadcast operand must be summed
        // over the axes broadcasting stretched, and forgetting it in one rule out
        // of thirty is the classic autodiff bug.
        accumulate(cotangents, input, reduceToShape(grad, node.inputShapes[i]!));
      }
      if (!options.retainGraph) releaseNode(node);
    }

    // Leaves receive their gradient; interior tensors keep theirs only in the map.
    for (const [tensor, grad] of cotangents) {
      if (tensor === root && root.gradFn !== null) continue;
      if (!tensor.requiresGrad || tensor.gradFn !== null) continue;
      const total = tensor.grad ? addInto(tensor.grad, grad) : grad;
      // A gradient attached to a leaf must outlive the scope backward ran in: the
      // leaf is a parameter that outlives it, and the optimizer reads the gradient
      // after the scope closes. Without this, the natural
      // `tidy(() => loss.backward())` would hand the optimizer freed tensors.
      keepInScope(total);
      tensor.grad = total;
    }
  });
}

/**
 * Add a cotangent to whatever has already flowed into a tensor.
 *
 * @internal
 */
function accumulate(
  cotangents: Map<Tensor, Tensor>,
  tensor: Tensor,
  grad: Tensor,
): void {
  const existing = cotangents.get(tensor);
  cotangents.set(tensor, existing ? addInto(existing, grad) : grad);
}

/**
 * Tensors and their producing nodes, in reverse dispatch order.
 *
 * Iterative rather than recursive: a deep network would overflow the JS stack,
 * and transformer depth is exactly the case this has to survive.
 *
 * @internal
 */
function topologicalOrder(root: Tensor): GradNode[] {
  const order: GradNode[] = [];
  const visited = new Set<GradNode>();
  // Depth-first post-order, then reversed, so a node is emitted only after every
  // consumer of its output has been.
  const stack: { node: GradNode; expanded: boolean }[] = [];
  if (root.gradFn) stack.push({ node: root.gradFn, expanded: false });

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;
    if (frame.expanded) {
      stack.pop();
      if (!visited.has(frame.node)) {
        visited.add(frame.node);
        order.push(frame.node);
      }
      continue;
    }
    frame.expanded = true;
    if (visited.has(frame.node)) {
      stack.pop();
      continue;
    }
    for (const input of frame.node.inputs) {
      if (input.gradFn && !visited.has(input.gradFn)) {
        stack.push({ node: input.gradFn, expanded: false });
      }
    }
  }
  return order.reverse();
}

/**
 * The tensor a gradient node produced.
 *
 * Recorded on the node when dispatch attaches it, using a weak reference so the
 * tape does not keep an output alive that nobody else holds.
 *
 * @internal
 */
const nodeOutputs = new WeakMap<GradNode, WeakRef<Tensor>>();

/** Associate a node with the tensor it produced. */
export function setNodeOutput(node: GradNode, output: Tensor): void {
  nodeOutputs.set(node, new WeakRef(output));
}

/**
 * @internal
 */
function nodeOutput(node: GradNode): Tensor | undefined {
  return nodeOutputs.get(node)?.deref();
}

/**
 * Hooks the operation modules install, so this module does not import them and
 * create a cycle.
 *
 * @internal
 */
let hooks: {
  onesLike(t: Tensor): Tensor;
  add(a: Tensor, b: Tensor): Tensor;
  sumTo(t: Tensor, shape: readonly number[]): Tensor;
} | null = null;

/** Install the operations autodiff needs. Called once, at import. */
export function installAutogradHooks(value: NonNullable<typeof hooks>): void {
  hooks = value;
}

/**
 * @internal
 */
function onesLike(t: Tensor): Tensor {
  if (!hooks) throw new Error('autograd hooks are not installed');
  return hooks.onesLike(t);
}

/**
 * @internal
 */
function addInto(a: Tensor, b: Tensor): Tensor {
  if (!hooks) throw new Error('autograd hooks are not installed');
  return hooks.add(a, b);
}

/**
 * Sum a cotangent down to an operand's shape.
 *
 * @internal
 */
function reduceToShape(grad: Tensor, shape: readonly number[]): Tensor {
  if (grad.rank === shape.length && grad.shape.every((d, i) => d === shape[i])) return grad;
  if (!hooks) throw new Error('autograd hooks are not installed');
  return hooks.sumTo(grad, shape);
}
