/**
 * `Module` — parameter ownership and state serialisation.
 *
 * Parameters are registered explicitly rather than discovered by scanning
 * properties. Scanning cannot see `#private` fields, which this codebase uses for
 * all internal state, and it silently picks up anything tensor-shaped that
 * happened to be assigned — including buffers that should not be trained.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor/nn`; import from there.
 */
import type { Tensor } from '../tensor.ts';
import type { Device } from '../backend.ts';
import { noGrad } from '../autograd.ts';
import { to as transfer } from '../transfer.ts';

/** A named parameter or buffer, with its dot-path. */
export interface NamedTensor {
  name: string;
  tensor: Tensor;
}

/**
 * Base class for anything holding trainable state.
 */
export class Module {
  /**
   * Trainable parameters owned directly by this module.
   *
   * @internal
   */
  #params = new Map<string, Tensor>();

  /**
   * Non-trainable state owned directly by this module, such as running
   * statistics. Serialised alongside parameters but never given gradients.
   *
   * @internal
   */
  #buffers = new Map<string, Tensor>();

  /**
   * Child modules, in registration order.
   *
   * @internal
   */
  #children = new Map<string, Module>();

  /**
   * Whether the module is in training mode. Read by `Dropout`.
   *
   * @internal
   */
  #training = true;

  /** Register a trainable parameter. */
  registerParameter(name: string, tensor: Tensor): Tensor {
    tensor.requiresGrad = true;
    this.#params.set(name, tensor);
    return tensor;
  }

  /** Register non-trainable state. */
  registerBuffer(name: string, tensor: Tensor): Tensor {
    this.#buffers.set(name, tensor);
    return tensor;
  }

  /** Register a child module. */
  registerModule<T extends Module>(name: string, child: T): T {
    this.#children.set(name, child);
    return child;
  }

  /** A registered parameter. */
  parameter(name: string): Tensor {
    const found = this.#params.get(name);
    if (!found) throw new Error(`no parameter named '${name}'`);
    return found;
  }

  /** A registered buffer. */
  buffer(name: string): Tensor {
    const found = this.#buffers.get(name);
    if (!found) throw new Error(`no buffer named '${name}'`);
    return found;
  }

  /** A registered child module. */
  child(name: string): Module {
    const found = this.#children.get(name);
    if (!found) throw new Error(`no child module named '${name}'`);
    return found;
  }

  /** Whether the module is in training mode. */
  get training(): boolean {
    return this.#training;
  }

  /** Switch to training mode, recursively. */
  train(): this {
    this.#training = true;
    for (const child of this.#children.values()) child.train();
    return this;
  }

  /** Switch to evaluation mode, recursively. */
  eval(): this {
    this.#training = false;
    for (const child of this.#children.values()) child.eval();
    return this;
  }

  /**
   * Move every parameter and buffer to a device, recursively.
   *
   * Replaces the tensors in place and disposes the originals, so an optimiser must
   * be constructed after the move rather than before: it holds the parameters it was
   * given, and those are the ones left behind.
   *
   * Transfers are synchronisation points, which is why this is asynchronous where
   * `train()` and `eval()` are not. It is a setup operation, not a per-step one.
   */
  async to(target: 'auto' | string | Device): Promise<this> {
    for (const table of [this.#params, this.#buffers]) {
      for (const [name, tensor] of table) {
        const moved = await transfer(tensor, target);
        if (moved === tensor) continue;
        // Parameters carry `requiresGrad` across, and gradients accumulated on the
        // old device do not follow: they belong to storage that is about to go.
        table.set(name, moved);
        tensor.grad?.dispose();
        tensor.grad = null;
        tensor.dispose();
      }
    }
    for (const child of this.#children.values()) await child.to(target);
    return this;
  }

  /** Every trainable parameter, this module's and its children's. */
  parameters(): Tensor[] {
    return this.namedParameters().map((entry) => entry.tensor);
  }

  /** Every trainable parameter with its dot-path. */
  namedParameters(prefix = ''): NamedTensor[] {
    const out: NamedTensor[] = [];
    for (const [name, tensor] of this.#params) {
      out.push({ name: prefix + name, tensor });
    }
    for (const [name, child] of this.#children) {
      out.push(...child.namedParameters(`${prefix}${name}.`));
    }
    return out;
  }

  /** Every buffer with its dot-path. */
  namedBuffers(prefix = ''): NamedTensor[] {
    const out: NamedTensor[] = [];
    for (const [name, tensor] of this.#buffers) {
      out.push({ name: prefix + name, tensor });
    }
    for (const [name, child] of this.#children) {
      out.push(...child.namedBuffers(`${prefix}${name}.`));
    }
    return out;
  }

  /** Child modules with their names. */
  namedChildren(): { name: string; module: Module }[] {
    return [...this.#children].map(([name, module]) => ({ name, module }));
  }

  /**
   * Every parameter and buffer, keyed by dot-path.
   *
   * The tensors are the live ones, not copies: saving means reading them back.
   */
  stateDict(): Map<string, Tensor> {
    const out = new Map<string, Tensor>();
    for (const { name, tensor } of this.namedParameters()) out.set(name, tensor);
    for (const { name, tensor } of this.namedBuffers()) out.set(name, tensor);
    return out;
  }

  /**
   * Copy values from a state dictionary into this module's tensors.
   *
   * Shapes and dtypes must match: silently reinterpreting a mismatched tensor
   * would produce a model that runs and is wrong.
   */
  loadStateDict(state: ReadonlyMap<string, Tensor>, options: { strict?: boolean } = {}): void {
    const strict = options.strict ?? true;
    const own = this.stateDict();
    const missing: string[] = [];
    for (const [name, target] of own) {
      const source = state.get(name);
      if (!source) {
        missing.push(name);
        continue;
      }
      if (source.dtype !== target.dtype) {
        throw new Error(
          `state entry '${name}' has dtype ${source.dtype}, expected ${target.dtype}`,
        );
      }
      if (source.rank !== target.rank || !source.shape.every((d, i) => d === target.shape[i])) {
        throw new Error(
          `state entry '${name}' has shape [${source.shape.join(', ')}], expected [${target.shape.join(', ')}]`,
        );
      }
      copyInto(target, source);
    }
    if (strict) {
      const unexpected = [...state.keys()].filter((name) => !own.has(name));
      if (missing.length > 0 || unexpected.length > 0) {
        throw new Error(
          `state dictionary does not match the module: missing [${missing.join(', ')}], unexpected [${unexpected.join(', ')}]`,
        );
      }
    }
  }

  /** Clear every parameter gradient. */
  zeroGrad(options: { setToNull?: boolean } = {}): void {
    const setToNull = options.setToNull ?? true;
    for (const parameter of this.parameters()) {
      if (!parameter.grad) continue;
      if (setToNull) {
        parameter.grad.dispose();
        parameter.grad = null;
      } else {
        noGrad(() => {
          const zeroed = parameter.grad!.mul(0);
          parameter.grad!.dispose();
          parameter.grad = zeroed;
        });
      }
    }
  }

  /** Dispose every parameter and buffer this module owns. */
  dispose(): void {
    for (const parameter of this.#params.values()) parameter.dispose();
    for (const buffer of this.#buffers.values()) buffer.dispose();
    for (const child of this.#children.values()) child.dispose();
    this.#params.clear();
    this.#buffers.clear();
  }

  /** Total number of trainable scalars. */
  parameterCount(): number {
    return this.parameters().reduce((total, p) => total + p.size, 0);
  }
}

/**
 * Copy one tensor's values into another, bypassing the graph.
 *
 * Loading weights is not a differentiable operation and recording it would leave
 * the destination with a gradient edge to a tensor the caller is about to drop.
 *
 * @internal
 */
function copyInto(target: Tensor, source: Tensor): void {
  const bytes = target.byteLength;
  const stream = target.backend.createStream();
  target.backend.copyD2D(
    target.storage.pooled.buffer,
    target.offset * (bytes / Math.max(target.size, 1)),
    source.storage.pooled.buffer,
    source.offset * (bytes / Math.max(source.size, 1)),
    bytes,
    stream,
  );
}
