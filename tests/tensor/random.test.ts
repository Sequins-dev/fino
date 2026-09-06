/**
 * Sampling on the device.
 *
 * Counter-based sampling makes an element's value a pure function of the key, the
 * counter block, and the element's index — so the same stream has to come out of a
 * sequential host loop and a parallel kernel alike. These check that it does, which is
 * the property the whole scheme exists to provide.
 */
import { describe, it } from 'fino:test/test';
import { Generator, bernoulli, device, listDevices, rand, randint, randn } from 'fino:tensor';

describe('device sampling', () => {
  it('draws the same stream on every backend', async (t) => {
    const streams = new Map<string, number[]>();
    for (const dev of await listDevices()) {
      const generator = new Generator(1234);
      const values = rand([64], { generator, device: dev });
      streams.set(dev.type, [...(await values.data())].map(Number));
      values.dispose();
    }
    const reference = streams.get('cpu')!;
    for (const [type, values] of streams) {
      if (type === 'cpu') continue;
      const worst = Math.max(...values.map((v, i) => Math.abs(v - reference[i]!)));
      t.ok(worst < 1e-6, `${type} matches the reference stream to ${worst}`);
    }
  });

  it('advances, so two draws differ', async (t) => {
    const dev = await device('auto');
    const generator = new Generator(7);
    const first = [...(await rand([32], { generator, device: dev }).data())].map(Number);
    const second = [...(await rand([32], { generator, device: dev }).data())].map(Number);
    t.ok(
      first.some((v, i) => v !== second[i]),
      'a second draw from the same generator is a different block',
    );
  });

  it('repeats exactly for the same seed', async (t) => {
    const dev = await device('auto');
    const draw = async () =>
      [...(await rand([32], { generator: new Generator(99), device: dev }).data())].map(Number);
    t.deepEqual(await draw(), await draw(), 'the same seed gives the same values');
  });

  it('respects the range it is given', async (t) => {
    const dev = await device('auto');
    const values = [
      ...(await rand([256], { generator: new Generator(3), device: dev, low: -2, high: 5 }).data()),
    ].map(Number);
    t.ok(
      values.every((v) => v >= -2 && v < 5),
      'every uniform sample lands inside [low, high)',
    );
  });

  it('draws integers inside the range', async (t) => {
    const dev = await device('auto');
    const values = [
      ...(await randint([256], {
        generator: new Generator(5),
        device: dev,
        low: 3,
        high: 9,
      }).data()),
    ].map(Number);
    t.ok(
      values.every((v) => Number.isInteger(v) && v >= 3 && v < 9),
      'every integer sample is a whole number inside [low, high)',
    );
  });

  it('draws only zeros and ones from bernoulli', async (t) => {
    const dev = await device('auto');
    const values = [
      ...(await bernoulli([256], { generator: new Generator(11), device: dev, p: 0.5 }).data()),
    ].map(Number);
    t.ok(
      values.every((v) => v === 0 || v === 1),
      'bernoulli is a mask',
    );
    const ones = values.filter((v) => v === 1).length;
    // Far too loose to be a distribution test — it catches a kernel that returns a
    // constant, which is the failure worth catching here.
    t.ok(ones > 50 && ones < 206, `both outcomes occur (${ones}/256 ones)`);
  });

  it('produces a plausible normal', async (t) => {
    const dev = await device('auto');
    const values = [
      ...(await randn([4096], { generator: new Generator(13), device: dev }).data()),
    ].map(Number);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
    t.ok(Math.abs(mean) < 0.1, `mean near zero (${mean.toFixed(4)})`);
    t.ok(Math.abs(variance - 1) < 0.15, `variance near one (${variance.toFixed(4)})`);
  });

  it('shifts and scales the normal', async (t) => {
    const dev = await device('auto');
    const values = [
      ...(await randn([4096], {
        generator: new Generator(17),
        device: dev,
        mean: 5,
        stddev: 2,
      }).data()),
    ].map(Number);
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    t.ok(Math.abs(mean - 5) < 0.2, `mean near five (${mean.toFixed(4)})`);
  });

  it('splits into independent substreams', async (t) => {
    const dev = await device('auto');
    const parent = new Generator(21);
    const a = [...(await rand([32], { generator: parent.split(0), device: dev }).data())].map(
      Number,
    );
    const b = [...(await rand([32], { generator: parent.split(1), device: dev }).data())].map(
      Number,
    );
    t.ok(
      a.some((v, i) => v !== b[i]),
      'two substreams of one generator are different',
    );
  });
});
