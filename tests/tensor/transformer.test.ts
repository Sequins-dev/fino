/**
 * A miniature transformer, trained on every available device.
 *
 * This is the claim the engine exists to support, checked rather than asserted: that a
 * transformer can be built from the operations this engine has, differentiated by its
 * tape, and trained to convergence on a GPU through kernels it generated. Everything
 * here is composition — there is no attention kernel, no fused softmax, no special
 * case. If the primitive set were wrong, this is what would not compile.
 *
 * The task is deliberately one that attention is *needed* for: predict the previous
 * token. A model without attention sees only the current token and a position, and the
 * sequences are random, so there is nothing in either to predict from — the loss would
 * sit at chance. Learning it means information moved between positions.
 */
import { describe, it } from 'fino:test/test';
import { arange, device, listDevices, tensor, tidy } from 'fino:tensor';
import type { Device, Tensor } from 'fino:tensor';
import { Embedding, LayerNorm, Linear, Module, TransformerBlock } from 'fino:tensor/nn';
import { crossEntropy } from 'fino:tensor/nn';
import { AdamW } from 'fino:tensor/optim';

/** Vocabulary, sequence length, width, and heads. Small enough to train in a test. */
const VOCAB = 12;
const TOKENS = 8;
const WIDTH = 32;
const HEADS = 4;
const BATCH = 16;

/** A decoder-only language model, the smallest thing worth the name. */
class MiniTransformer extends Module {
  constructor() {
    super();
    this.registerModule('tokens', new Embedding(VOCAB, WIDTH));
    this.registerModule('positions', new Embedding(TOKENS, WIDTH));
    this.registerModule('block', new TransformerBlock(WIDTH, HEADS, { mlpRatio: 2 }));
    this.registerModule('norm', new LayerNorm(WIDTH));
    this.registerModule('head', new Linear(WIDTH, VOCAB));
  }

  /** Map `[batch, tokens]` of ids to `[batch, tokens, vocab]` of logits. */
  forward(ids: Tensor, positions: Tensor): Tensor {
    const embedded = (this.child('tokens') as Embedding)
      .forward(ids)
      .add((this.child('positions') as Embedding).forward(positions));
    const encoded = (this.child('block') as TransformerBlock).forward(embedded);
    return (this.child('head') as Linear).forward(
      (this.child('norm') as LayerNorm).forward(encoded),
    );
  }
}

/** Deterministic token sequences, so a failure reproduces. */
function sequences(count: number, seed: number): number[] {
  let state = (seed * 2654435761) >>> 0 || 1;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    out.push(state % VOCAB);
  }
  return out;
}

/**
 * Targets: the previous token, with the first position predicting itself.
 *
 * The first position has nothing before it, so it is given a target it can reach from
 * its own embedding. Every other position needs to read one step back.
 */
function previousTokens(ids: readonly number[]): number[] {
  const out: number[] = [];
  for (let b = 0; b < ids.length / TOKENS; b++) {
    for (let t = 0; t < TOKENS; t++) {
      out.push(t === 0 ? ids[b * TOKENS]! : ids[b * TOKENS + t - 1]!);
    }
  }
  return out;
}

describe('a miniature transformer', () => {
  it('learns to read one position back, on every device', async (t) => {
    for (const dev of await listDevices()) {
      const model = new MiniTransformer();
      await model.to(dev);
      const optimizer = new AdamW(model.parameters(), { lr: 0.02 });

      const ids = sequences(BATCH * TOKENS, 7);
      const input = await tensor(ids, {
        shape: [BATCH, TOKENS],
        dtype: 'i32',
        device: dev,
      });
      const target = await tensor(previousTokens(ids), {
        shape: [BATCH * TOKENS],
        dtype: 'i32',
        device: dev,
      });
      // One row of positions per batch item, which broadcasting handles from a single
      // [1, tokens] lookup.
      const positions = (
        await arange(TOKENS, { dtype: 'i32', device: dev })
      ).reshape([1, TOKENS]).expand([BATCH, TOKENS]);

      const loss = (): Tensor => {
        const logits = model.forward(input, positions);
        return crossEntropy(logits.reshape([BATCH * TOKENS, VOCAB]), target);
      };

      const before = await tidy(() => loss()).item();
      let last = before;
      for (let step = 0; step < 300; step++) {
        // `backward()` runs *inside* the scope. The tape's saved tensors are created
        // by the forward pass, so a scope that closed first would have disposed
        // exactly what the backward pass needs.
        const value = tidy(() => {
          const objective = loss();
          objective.backward();
          return objective;
        });
        optimizer.step();
        optimizer.zeroGrad();
        // Reading the loss is what a training loop does anyway, and it is also the
        // synchronisation the device needs: queued work is submitted, and a kernel
        // this model has not used before gets a chance to finish compiling.
        last = await value.item();
        value.dispose();
      }
      const after = last;

      // Chance is ln(12) = 2.48, and this task cannot be learned below it without
      // attention: the model sees only a token and a position, and the same token at
      // the same position has different predecessors in different sequences. Beating
      // chance therefore means information moved between positions, which is the whole
      // claim.
      //
      // The bound is set by the slowest device rather than the best. Backends sum in
      // different orders, so their trajectories diverge over a few hundred steps of a
      // non-convex problem; given longer, every one of them drives this below 0.01.
      t.ok(
        before > 2.0,
        `${dev.type} starts at or above chance (${before.toFixed(3)}, chance is ${Math.log(VOCAB).toFixed(3)})`,
      );
      t.ok(
        after < 1.5 && after < before / 2,
        `${dev.type} learns the task (${before.toFixed(3)} -> ${after.toFixed(3)})`,
      );

      model.dispose();
      input.dispose();
      target.dispose();
      positions.dispose();
    }
  });

  it('cannot see the future', async (t) => {
    // Causality is what separates a decoder from a model that has read the answer.
    // Changing the last token must leave every earlier output untouched — exactly, not
    // approximately, since a masked weight is zero rather than small.
    for (const dev of await listDevices()) {
      const model = new MiniTransformer();
      await model.to(dev);
      const ids = sequences(TOKENS, 11);
      const positions = (await arange(TOKENS, { dtype: 'i32', device: dev })).reshape([
        1,
        TOKENS,
      ]);

      const original = await tensor(ids, { shape: [1, TOKENS], dtype: 'i32', device: dev });
      const changed = [...ids];
      changed[TOKENS - 1] = (changed[TOKENS - 1]! + 5) % VOCAB;
      const altered = await tensor(changed, {
        shape: [1, TOKENS],
        dtype: 'i32',
        device: dev,
      });

      const a = [...(await model.forward(original, positions).data())].map(Number);
      const b = [...(await model.forward(altered, positions).data())].map(Number);

      let earlier = 0;
      let last = 0;
      for (let token = 0; token < TOKENS; token++) {
        for (let v = 0; v < VOCAB; v++) {
          const delta = Math.abs(a[token * VOCAB + v]! - b[token * VOCAB + v]!);
          if (token < TOKENS - 1) earlier = Math.max(earlier, delta);
          else last = Math.max(last, delta);
        }
      }
      t.equal(earlier, 0, `${dev.type} leaves earlier positions bit-identical`);
      t.ok(last > 0, `${dev.type} does change the position that saw the new token`);

      model.dispose();
      original.dispose();
      altered.dispose();
      positions.dispose();
    }
  });

  it('agrees with the reference oracle on a forward pass', async (t) => {
    // The same weights on every device must produce the same logits, which is what
    // makes the training above a property of the model rather than of a backend.
    const cpu = await device('cpu');
    const reference = new MiniTransformer();
    await reference.to(cpu);
    const ids = sequences(2 * TOKENS, 13);
    const state = reference.stateDict();

    const cpuIds = await tensor(ids, { shape: [2, TOKENS], dtype: 'i32', device: cpu });
    const cpuPositions = (await arange(TOKENS, { dtype: 'i32', device: cpu })).reshape([
      1,
      TOKENS,
    ]);
    const expected = [...(await reference.forward(cpuIds, cpuPositions).data())].map(Number);

    for (const dev of await listDevices()) {
      if (dev.type === 'cpu') continue;
      const model = new MiniTransformer();
      await model.to(dev);
      // Move the reference weights across rather than trusting two initialisations to
      // agree; the point is the arithmetic, not the random numbers.
      const moved = new Map<string, Tensor>();
      for (const [name, value] of state) moved.set(name, await value.to(dev));
      model.loadStateDict(moved);

      const devIds = await tensor(ids, { shape: [2, TOKENS], dtype: 'i32', device: dev });
      const devPositions = (await arange(TOKENS, { dtype: 'i32', device: dev })).reshape([
        1,
        TOKENS,
      ]);
      const got = [...(await model.forward(devIds, devPositions).data())].map(Number);

      let worst = 0;
      for (let i = 0; i < expected.length; i++) {
        worst = Math.max(worst, Math.abs(got[i]! - expected[i]!));
      }
      t.ok(worst < 2e-3, `${dev.type} matches the oracle within ${worst.toExponential(2)}`);

      for (const value of moved.values()) value.dispose();
      model.dispose();
      devIds.dispose();
      devPositions.dispose();
    }

    reference.dispose();
    cpuIds.dispose();
    cpuPositions.dispose();
  });
});
