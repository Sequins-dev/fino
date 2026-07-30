/**
 * End-to-end training tests.
 *
 * These are the engine's real acceptance criteria: not that individual operations
 * are correct, but that a model built from them converges. A gradient sign error
 * or a broken optimizer update passes every unit test and fails here.
 */
import { describe, it } from 'fino:test/test';
import { Generator, device, poolStats, tensor, tidy } from 'fino:tensor';
import type { Tensor } from 'fino:tensor';
import {
  Dropout,
  Embedding,
  LayerNorm,
  Linear,
  Module,
  Sequential,
  crossEntropy,
  gelu,
  mseLoss,
  softmax,
} from 'fino:tensor/nn';
import { Adam, AdamW, CosineSchedule, LinearWarmup, SGD, clipGradNorm } from 'fino:tensor/optim';

describe('Module', () => {
  it('registers and reports parameters', (t) => {
    const layer = new Linear(3, 2);
    t.equal(layer.parameters().length, 2, 'weight and bias');
    t.equal(layer.parameterCount(), 3 * 2 + 2, 'scalar count');
    t.deepEqual(
      layer.namedParameters().map((p) => p.name).sort(),
      ['bias', 'weight'],
      'named parameters',
    );
  });
  it('omits the bias when asked', (t) => {
    const layer = new Linear(3, 2, { bias: false });
    t.equal(layer.parameters().length, 1, 'weight only');
  });
  it('reports nested parameters with dot-paths', (t) => {
    const model = new Sequential(new Linear(2, 3), new Linear(3, 1));
    t.deepEqual(
      model.namedParameters().map((p) => p.name).sort(),
      ['0.bias', '0.weight', '1.bias', '1.weight'],
      'child paths are prefixed',
    );
  });
  it('marks parameters as requiring gradients', (t) => {
    const layer = new Linear(2, 2);
    t.ok(
      layer.parameters().every((p) => p.requiresGrad),
      'registration implies trainability',
    );
  });
  it('switches training mode recursively', (t) => {
    const model = new Sequential(new Linear(2, 2), new Dropout(0.5));
    model.eval();
    t.ok(!model.training, 'parent is in evaluation mode');
    t.ok(!model.child('1').training, 'and so is the child');
    model.train();
    t.ok(model.child('1').training, 'training mode propagates too');
  });
  it('round-trips a state dictionary', async (t) => {
    const source = new Linear(3, 2, { generator: new Generator(1) });
    const target = new Linear(3, 2, { generator: new Generator(2) });
    const before = Array.from(await target.parameter('weight').data());
    target.loadStateDict(source.stateDict());
    const after = Array.from(await target.parameter('weight').data());
    const expected = Array.from(await source.parameter('weight').data());
    t.notEqual(JSON.stringify(before), JSON.stringify(expected), 'the two started different');
    t.deepEqual(after, expected, 'and now match');
  });
  it('rejects a mismatched state dictionary', (t) => {
    const source = new Linear(4, 2);
    const target = new Linear(3, 2);
    t.throws(
      () => target.loadStateDict(source.stateDict()),
      /has shape/,
      'shape mismatch is refused rather than reinterpreted',
    );
  });
  it('clears gradients', async (t) => {
    const layer = new Linear(2, 1, { generator: new Generator(3) });
    const x = await tensor([[1, 2]]);
    layer.forward(x).sum().backward();
    t.ok(layer.parameter('weight').grad !== null, 'a gradient was produced');
    layer.zeroGrad();
    t.equal(layer.parameter('weight').grad, null, 'and then cleared');
  });
});

describe('layers', () => {
  it('applies a linear layer', async (t) => {
    const layer = new Linear(2, 3, { generator: new Generator(7) });
    const x = await tensor([[1, 2], [3, 4]]);
    const y = layer.forward(x);
    t.deepEqual([...y.shape], [2, 3], 'batch is preserved, features change');
  });
  it('looks up embeddings', async (t) => {
    const embedding = new Embedding(5, 3, { generator: new Generator(11) });
    const ids = await tensor([0, 2, 2], { dtype: 'i32' });
    const out = embedding.forward(ids);
    t.deepEqual([...out.shape], [3, 3], 'one vector per id');
    const values = Array.from(await out.data());
    t.deepEqual(values.slice(3, 6), values.slice(6, 9), 'repeated ids give equal rows');
  });
  it('normalises to zero mean and unit variance', async (t) => {
    const norm = new LayerNorm(4, { affine: false });
    const x = await tensor([[1, 2, 3, 4], [10, 20, 30, 40]]);
    const out = norm.forward(x);
    const values = Array.from(await out.data());
    for (const row of [values.slice(0, 4), values.slice(4, 8)]) {
      const mean = row.reduce((a, b) => a + b, 0) / row.length;
      const variance = row.reduce((a, b) => a + (b - mean) ** 2, 0) / row.length;
      t.ok(Math.abs(mean) < 1e-5, `row mean is ~0 (${mean})`);
      t.ok(Math.abs(variance - 1) < 1e-3, `row variance is ~1 (${variance})`);
    }
  });
  it('applies an affine transform after normalising', async (t) => {
    const norm = new LayerNorm(3);
    t.equal(norm.parameters().length, 2, 'weight and bias are trainable');
    const x = await tensor([[1, 2, 3]]);
    const out = norm.forward(x);
    t.deepEqual([...out.shape], [1, 3], 'shape is unchanged');
  });
  it('normalises over several trailing axes', async (t) => {
    const { layerNorm, rmsNorm } = await import('fino:tensor/nn');
    // PyTorch's normalized_shape spanning two axes: statistics are taken over the
    // whole trailing run, not per-axis.
    const x = await tensor(
      Array.from({ length: 2 * 3 * 4 }, (_, i) => ((i % 7) - 3) / 2),
      { shape: [2, 3, 4] },
    );
    const out = layerNorm(x, null, null, 1e-5, 2);
    t.deepEqual([...out.shape], [2, 3, 4], 'shape is unchanged');
    const values = Array.from(await out.data());
    for (const row of [values.slice(0, 12), values.slice(12, 24)]) {
      const mean = row.reduce((a, b) => a + b, 0) / row.length;
      const variance = row.reduce((a, b) => a + (b - mean) ** 2, 0) / row.length;
      t.ok(Math.abs(mean) < 1e-4, `the twelve-element run has mean ~0 (${mean})`);
      t.ok(Math.abs(variance - 1) < 1e-3, `and variance ~1 (${variance})`);
    }
    const rms = rmsNorm(x, null, 1e-6, 2);
    t.deepEqual([...rms.shape], [2, 3, 4], 'rms keeps the shape too');
    t.throws(
      () => layerNorm(x, null, null, 1e-5, 4),
      /rank-3/,
      'more trailing axes than the tensor has is refused',
    );
  });
  it('drops elements in training and passes through in evaluation', async (t) => {
    const dropout = new Dropout(0.5, { generator: new Generator(13) });
    const x = await tensor(new Array(1000).fill(1));
    const trained = Array.from(await dropout.forward(x).data());
    const zeros = trained.filter((v) => v === 0).length;
    t.ok(zeros > 350 && zeros < 650, `about half were dropped (${zeros}/1000)`);
    // Inverted dropout scales survivors, so the expectation is preserved.
    const mean = trained.reduce((a, b) => a + b, 0) / trained.length;
    t.ok(Math.abs(mean - 1) < 0.15, `mean is preserved (${mean})`);
    dropout.eval();
    const evaluated = Array.from(await dropout.forward(x).data());
    t.ok(evaluated.every((v) => v === 1), 'evaluation is a no-op');
  });
  it('is reproducible from a seed', async (t) => {
    const a = new Linear(4, 4, { generator: new Generator(99) });
    const b = new Linear(4, 4, { generator: new Generator(99) });
    t.deepEqual(
      Array.from(await a.parameter('weight').data()),
      Array.from(await b.parameter('weight').data()),
      'the same seed gives the same weights',
    );
    const c = new Linear(4, 4, { generator: new Generator(100) });
    t.notEqual(
      JSON.stringify(Array.from(await a.parameter('weight').data())),
      JSON.stringify(Array.from(await c.parameter('weight').data())),
      'a different seed gives different weights',
    );
  });
});

describe('losses', () => {
  it('computes mean squared error', async (t) => {
    const prediction = await tensor([1, 2, 3]);
    const target = await tensor([1, 4, 3]);
    const loss = await mseLoss(prediction, target).item();
    t.ok(Math.abs(loss - 4 / 3) < 1e-6, `mean of squared differences (${loss})`);
  });
  it('computes cross-entropy against a known value', async (t) => {
    // Uniform logits over four classes give -log(1/4) regardless of the target.
    const logits = await tensor([[0, 0, 0, 0]]);
    const targets = await tensor([2], { dtype: 'i32' });
    const loss = await crossEntropy(logits, targets).item();
    t.ok(Math.abs(loss - Math.log(4)) < 1e-5, `loss is log(4) (${loss})`);
  });
  it('drops towards zero as logits favour the target', async (t) => {
    const targets = await tensor([0], { dtype: 'i32' });
    const uncertain = await crossEntropy(await tensor([[1, 1]]), targets).item();
    const confident = await crossEntropy(await tensor([[10, -10]]), targets).item();
    t.ok(confident < uncertain, 'a confident correct prediction costs less');
    t.ok(confident < 1e-6, `and approaches zero (${confident})`);
  });
  it('is stable for large logits', async (t) => {
    const logits = await tensor([[1000, 0]]);
    const targets = await tensor([0], { dtype: 'i32' });
    const loss = await crossEntropy(logits, targets).item();
    t.ok(Number.isFinite(loss), `no overflow (${loss})`);
  });
});

describe('optimizers', () => {
  it('descends a quadratic with SGD', async (t) => {
    // Minimising x^2 from x = 5 must approach zero.
    const x = await tensor([5], { requiresGrad: true });
    const optimizer = new SGD([x], { lr: 0.1 });
    for (let i = 0; i < 100; i++) {
      tidy(() => x.mul(x).sum().backward());
      optimizer.step();
      optimizer.zeroGrad();
    }
    const value = await x.item();
    t.ok(Math.abs(value) < 1e-6, `converged to zero (${value})`);
  });
  it('descends faster with momentum', async (t) => {
    const run = async (momentum: number): Promise<number> => {
      const x = await tensor([5], { requiresGrad: true });
      const optimizer = new SGD([x], { lr: 0.01, momentum });
      for (let i = 0; i < 20; i++) {
        tidy(() => x.mul(x).sum().backward());
        optimizer.step();
        optimizer.zeroGrad();
      }
      const value = Math.abs(await x.item());
      optimizer.dispose();
      return value;
    };
    const plain = await run(0);
    const withMomentum = await run(0.9);
    t.ok(withMomentum < plain, `momentum converged further (${withMomentum} < ${plain})`);
  });
  it('descends a quadratic with Adam', async (t) => {
    const x = await tensor([5], { requiresGrad: true });
    const optimizer = new Adam([x], { lr: 0.1 });
    for (let i = 0; i < 200; i++) {
      tidy(() => x.mul(x).sum().backward());
      optimizer.step();
      optimizer.zeroGrad();
    }
    const value = await x.item();
    t.ok(Math.abs(value) < 1e-3, `converged to zero (${value})`);
    optimizer.dispose();
  });
  it('decays weights with AdamW even without a gradient signal', async (t) => {
    // A parameter whose loss does not depend on it should still shrink, which is
    // exactly what decoupled decay means.
    const w = await tensor([1], { requiresGrad: true });
    const optimizer = new AdamW([w], { lr: 0.1, weightDecay: 0.5 });
    for (let i = 0; i < 5; i++) {
      tidy(() => w.mul(0).sum().backward());
      optimizer.step();
      optimizer.zeroGrad();
    }
    const value = await w.item();
    t.ok(value < 1 && value > 0, `the weight decayed towards zero (${value})`);
    optimizer.dispose();
  });
  it('clips gradients by global norm', async (t) => {
    const a = await tensor([3, 4], { requiresGrad: true });
    a.mul(a).sum().backward();
    // The gradient is 2x = [6, 8], whose norm is 10.
    const norm = await clipGradNorm([a], 1);
    t.ok(Math.abs(norm - 10) < 1e-4, `reported the pre-clipping norm (${norm})`);
    const clipped = Array.from(await a.grad!.data());
    const clippedNorm = Math.hypot(...clipped);
    t.ok(Math.abs(clippedNorm - 1) < 1e-5, `norm is now the maximum (${clippedNorm})`);
  });
  it('leaves small gradients alone', async (t) => {
    const a = await tensor([0.1], { requiresGrad: true });
    a.mul(a).sum().backward();
    const before = Array.from(await a.grad!.data());
    await clipGradNorm([a], 10);
    t.deepEqual(Array.from(await a.grad!.data()), before, 'nothing was scaled');
  });
});

describe('schedules', () => {
  it('warms up linearly then holds', (t) => {
    const schedule = new LinearWarmup(1, 4);
    t.equal(schedule.at(0), 0.25, 'first step');
    t.equal(schedule.at(3), 1, 'last warmup step reaches the peak');
    t.equal(schedule.at(50), 1, 'and holds after');
  });
  it('decays on a cosine after warmup', (t) => {
    const schedule = new CosineSchedule(1, 100, { warmupSteps: 10 });
    t.ok(schedule.at(0) < schedule.at(9), 'rises during warmup');
    t.ok(Math.abs(schedule.at(10) - 1) < 1e-9, 'peaks at the end of warmup');
    t.ok(schedule.at(99) < 0.01, 'decays to nearly zero');
    t.ok(schedule.at(50) < schedule.at(20), 'monotone decreasing after the peak');
  });
});

describe('training an MLP', () => {
  it('learns XOR', async (t) => {
    // XOR is not linearly separable, so success requires the hidden layer and a
    // working gradient path through its nonlinearity.
    const generator = new Generator(1234);
    const model = new Sequential(
      new Linear(2, 8, { generator }),
      new Linear(8, 1, { generator }),
    );
    // The activation lives between the layers; Sequential applies them directly,
    // so the nonlinearity is applied explicitly here.
    const forward = (x: Tensor): Tensor => {
      const hidden = (model.child('0') as Linear).forward(x).tanh();
      return (model.child('1') as Linear).forward(hidden);
    };

    const x = await tensor([[0, 0], [0, 1], [1, 0], [1, 1]]);
    const y = await tensor([[0], [1], [1], [0]]);
    const optimizer = new Adam(model.parameters(), { lr: 0.05 });

    let first = 0;
    let last = 0;
    for (let step = 0; step < 400; step++) {
      const loss = tidy(() => {
        const value = mseLoss(forward(x), y);
        value.backward();
        return value;
      });
      if (step === 0) first = await loss.item();
      if (step === 399) last = await loss.item();
      loss.dispose();
      optimizer.step();
      optimizer.zeroGrad();
    }

    t.ok(last < first, `loss decreased (${first} to ${last})`);
    t.ok(last < 0.01, `and converged (${last})`);

    const predictions = Array.from(await forward(x).data());
    t.ok(predictions[0]! < 0.5, `XOR(0,0) is low (${predictions[0]})`);
    t.ok(predictions[1]! > 0.5, `XOR(0,1) is high (${predictions[1]})`);
    t.ok(predictions[2]! > 0.5, `XOR(1,0) is high (${predictions[2]})`);
    t.ok(predictions[3]! < 0.5, `XOR(1,1) is low (${predictions[3]})`);
    optimizer.dispose();
  });
  it('classifies with cross-entropy', async (t) => {
    const generator = new Generator(555);
    const model = new Linear(2, 3, { generator });
    // Three well-separated clusters, one per class.
    const x = await tensor([
      [2, 2],
      [2.2, 1.8],
      [-2, 2],
      [-2.2, 1.8],
      [0, -2],
      [0.2, -2.2],
    ]);
    const targets = await tensor([0, 0, 1, 1, 2, 2], { dtype: 'i32' });
    const optimizer = new Adam(model.parameters(), { lr: 0.1 });

    for (let step = 0; step < 200; step++) {
      tidy(() => crossEntropy(model.forward(x), targets).backward());
      optimizer.step();
      optimizer.zeroGrad();
    }

    const loss = await crossEntropy(model.forward(x), targets).item();
    t.ok(loss < 0.1, `loss converged (${loss})`);
    const predicted = Array.from(await model.forward(x).argmax(1).data());
    t.deepEqual(predicted, [0, 0, 1, 1, 2, 2], 'every example is classified correctly');
    optimizer.dispose();
  });
});

describe('training a transformer block', () => {
  it('learns to copy a token through attention', async (t) => {
    // A single pre-norm transformer block: embedding, self-attention, residual,
    // layer norm, and a gated feed-forward. This exercises every piece an LLM
    // needs — embedding gather, batched matmul, softmax, normalisation, residual
    // paths — and its gradient path through all of them.
    const generator = new Generator(2024);
    const vocab = 6;
    const dim = 16;
    const heads = 1;
    const sequence = 4;

    class Block extends Module {
      readonly embed = this.registerModule('embed', new Embedding(vocab, dim, { generator }));
      readonly q = this.registerModule('q', new Linear(dim, dim, { generator }));
      readonly k = this.registerModule('k', new Linear(dim, dim, { generator }));
      readonly v = this.registerModule('v', new Linear(dim, dim, { generator }));
      readonly proj = this.registerModule('proj', new Linear(dim, dim, { generator }));
      readonly norm1 = this.registerModule('norm1', new LayerNorm(dim));
      readonly norm2 = this.registerModule('norm2', new LayerNorm(dim));
      readonly up = this.registerModule('up', new Linear(dim, dim * 2, { generator }));
      readonly down = this.registerModule('down', new Linear(dim * 2, dim, { generator }));
      readonly head = this.registerModule('head', new Linear(dim, vocab, { generator }));

      forward(ids: Tensor): Tensor {
        const embedded = this.embed.forward(ids);
        const normed = this.norm1.forward(embedded);
        const query = this.q.forward(normed);
        const key = this.k.forward(normed);
        const value = this.v.forward(normed);
        const scale = 1 / Math.sqrt(dim / heads);
        const scores = query.matmul(key.transpose()).mul(scale);
        const attention = softmax(scores, 1).matmul(value);
        const afterAttention = embedded.add(this.proj.forward(attention));
        const feedForward = this.down.forward(gelu(this.up.forward(this.norm2.forward(afterAttention))));
        return this.head.forward(afterAttention.add(feedForward));
      }
    }

    const model = new Block();
    t.ok(model.parameterCount() > 1000, `the block has real parameters (${model.parameterCount()})`);

    // Task: predict each position's own token. Solvable, and it still requires the
    // whole stack to be differentiated correctly.
    const ids = await tensor([1, 3, 2, 4], { dtype: 'i32' });
    const targets = await tensor([1, 3, 2, 4], { dtype: 'i32' });
    const optimizer = new AdamW(model.parameters(), { lr: 0.02, weightDecay: 0.001 });
    const schedule = new CosineSchedule(0.02, 300, { warmupSteps: 20 });

    const initial = await crossEntropy(model.forward(ids), targets).item();
    for (let step = 0; step < 300; step++) {
      tidy(() => crossEntropy(model.forward(ids), targets).backward());
      await clipGradNorm(model.parameters(), 1);
      optimizer.lr = schedule.at(optimizer.steps);
      optimizer.step();
      optimizer.zeroGrad();
    }
    const final = await crossEntropy(model.forward(ids), targets).item();

    t.ok(final < initial, `loss decreased (${initial} to ${final})`);
    t.ok(final < 0.05, `and converged (${final})`);
    const predicted = Array.from(await model.forward(ids).argmax(1).data());
    t.deepEqual(predicted, [1, 3, 2, 4], 'every position predicts its own token');
    t.equal(predicted.length, sequence, 'one prediction per position');
    optimizer.dispose();
  });
  it('keeps memory bounded while training', async (t) => {
    const dev = await device();
    const generator = new Generator(31337);
    const model = new Sequential(new Linear(4, 8, { generator }), new Linear(8, 4, { generator }));
    const x = await tensor([[1, 2, 3, 4]]);
    const y = await tensor([[1, 0, 0, 1]]);
    const optimizer = new Adam(model.parameters(), { lr: 0.01 });

    const step = () => {
      tidy(() => mseLoss(model.forward(x), y).backward());
      optimizer.step();
      optimizer.zeroGrad();
    };
    // Warm up so the pool and the optimizer state are fully allocated.
    for (let i = 0; i < 5; i++) step();
    const baseline = poolStats(dev).liveBuffers;
    for (let i = 0; i < 50; i++) step();
    t.equal(
      poolStats(dev).liveBuffers,
      baseline,
      'fifty steps left the live-buffer count unchanged',
    );
    optimizer.dispose();
  });
});
