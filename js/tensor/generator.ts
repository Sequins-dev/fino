/**
 * Seeded random number generation.
 *
 * Sampling is counter-based rather than sequential: element `i` is derived from
 * `(key, counter + i)` with no shared mutable state. That is what makes the
 * scheme portable — any thread on any device computes element `i` independently,
 * so a GPU kernel and the reference implementation produce the *same* stream
 * rather than merely similarly distributed ones. Cross-backend trajectory parity
 * is then a testable property instead of a hope.
 *
 * Specified in `specs/tensor-contract.md` §8.
 *
 * @internal
 *
 * This module is re-exported through `fino:tensor`; import from there.
 */

/** 2^64 - 1. */
const MASK64 = 0xffffffffffffffffn;

/** 2^32 - 1. */
const MASK32 = 0xffffffffn;

/** Philox multipliers. */
const PHILOX_M0 = 0xd2511f53n;
const PHILOX_M1 = 0xcd9e8d57n;

/** Weyl increments for the two key words. */
const PHILOX_W0 = 0x9e3779b9;
const PHILOX_W1 = 0xbb67ae85;

/** Rounds of the Philox permutation. Ten is the standard, well-tested count. */
const PHILOX_ROUNDS = 10;

/**
 * splitmix64, used to derive keys from a seed and to split substreams.
 *
 * @internal
 */
function splitmix64(state: bigint): { value: bigint; next: bigint } {
  let next = (state + 0x9e3779b97f4a7c15n) & MASK64;
  let z = next;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK64;
  z = z ^ (z >> 31n);
  return { value: z & MASK64, next };
}

/**
 * Philox4x32-10.
 *
 * Produces four independent `u32` values from a two-word key and a four-word
 * counter. Implemented with `Number` arithmetic on 32-bit halves so it can be
 * mirrored exactly by a GPU kernel.
 */
export function philox4x32(
  key0: number,
  key1: number,
  counter0: number,
  counter1: number,
  counter2 = 0,
  counter3 = 0,
): [number, number, number, number] {
  let c0 = counter0 >>> 0;
  let c1 = counter1 >>> 0;
  let c2 = counter2 >>> 0;
  let c3 = counter3 >>> 0;
  let k0 = key0 >>> 0;
  let k1 = key1 >>> 0;

  for (let round = 0; round < PHILOX_ROUNDS; round++) {
    const product0 = (BigInt(c0) * PHILOX_M0) & MASK64;
    const product1 = (BigInt(c2) * PHILOX_M1) & MASK64;
    const hi0 = Number((product0 >> 32n) & MASK32) >>> 0;
    const lo0 = Number(product0 & MASK32) >>> 0;
    const hi1 = Number((product1 >> 32n) & MASK32) >>> 0;
    const lo1 = Number(product1 & MASK32) >>> 0;

    const next0 = (hi1 ^ c1 ^ k0) >>> 0;
    const next1 = lo1;
    const next2 = (hi0 ^ c3 ^ k1) >>> 0;
    const next3 = lo0;
    c0 = next0;
    c1 = next1;
    c2 = next2;
    c3 = next3;

    if (round < PHILOX_ROUNDS - 1) {
      k0 = (k0 + PHILOX_W0) >>> 0;
      k1 = (k1 + PHILOX_W1) >>> 0;
    }
  }
  return [c0, c1, c2, c3];
}

/** A `u32` word turned into a float in `[0, 1)`. */
export function uniformFromBits(bits: number): number {
  // Twenty-four bits is exactly the f32 mantissa, so every result is
  // representable and the distribution has no gaps.
  return (bits >>> 8) * 2 ** -24;
}

/**
 * A pair of standard normals from two uniform words, by Box–Muller.
 *
 * The first uniform is nudged away from zero because `log(0)` is negative
 * infinity.
 */
export function normalFromBits(bits0: number, bits1: number): [number, number] {
  const u1 = Math.max(uniformFromBits(bits0), 2 ** -24);
  const u2 = uniformFromBits(bits1);
  const radius = Math.sqrt(-2 * Math.log(u1));
  const angle = 2 * Math.PI * u2;
  return [radius * Math.cos(angle), radius * Math.sin(angle)];
}

/** An integer in `[lo, hi)` without modulo bias. */
export function intFromBits(bits: number, lo: number, hi: number): number {
  const range = hi - lo;
  if (range <= 0) throw new Error(`randint needs hi > lo, got [${lo}, ${hi})`);
  // Multiply-shift: the high word of a 64-bit product is uniform over the range.
  return lo + Number((BigInt(bits >>> 0) * BigInt(range)) >> 32n);
}

/** A position in a random stream, as passed to a backend. */
export interface RngPosition {
  key: readonly [number, number];
  counter: number;
}

/**
 * A seeded random source.
 *
 * Holds a key and an offset. Drawing advances the offset by the number of counter
 * blocks consumed, so successive draws never overlap.
 */
export class Generator {
  #key0: number;
  #key1: number;
  #offset = 0;

  constructor(seed: number | bigint = 0) {
    // Derive two well-mixed key words from the seed so that nearby seeds do not
    // produce correlated streams.
    const { value } = splitmix64(BigInt(seed) & MASK64);
    this.#key0 = Number(value & MASK32) >>> 0;
    this.#key1 = Number((value >> 32n) & MASK32) >>> 0;
  }

  /** The key words, for diagnostics and reproduction. */
  get key(): readonly [number, number] {
    return [this.#key0, this.#key1];
  }

  /** Counter blocks consumed so far. */
  get offset(): number {
    return this.#offset;
  }

  /**
   * Reserve enough counter blocks for `count` elements.
   *
   * Four elements come from each block, matching Philox's four output words.
   */
  reserve(count: number): RngPosition {
    const position: RngPosition = {
      key: [this.#key0, this.#key1],
      counter: this.#offset,
    };
    this.#offset += Math.ceil(count / 4);
    return position;
  }

  /**
   * Derive an independent substream.
   *
   * Used for per-layer dropout masks and per-worker data shuffling, where
   * correlated streams would be a subtle source of bias.
   */
  split(index: number): Generator {
    const combined = ((BigInt(this.#key1) << 32n) | BigInt(this.#key0)) & MASK64;
    const { value } = splitmix64((combined + BigInt(index) * 0x9e3779b97f4a7c15n) & MASK64);
    const child = new Generator(0);
    child.#key0 = Number(value & MASK32) >>> 0;
    child.#key1 = Number((value >> 32n) & MASK32) >>> 0;
    return child;
  }

  /** Restore a generator to a known position. */
  seekTo(offset: number): void {
    this.#offset = offset;
  }

  /**
   * Sample `count` uniform values on the host.
   *
   * Used by initialisers, which build parameters before any device work happens.
   */
  uniform(count: number, low = 0, high = 1): number[] {
    const position = this.reserve(count);
    const out = new Array<number>(count);
    const scale = high - low;
    for (let i = 0; i < count; i++) {
      const block = position.counter + (i >> 2);
      const words = philox4x32(position.key[0], position.key[1], block, 0);
      out[i] = low + uniformFromBits(words[i & 3]!) * scale;
    }
    return out;
  }

  /** Sample `count` standard normals on the host, scaled and shifted. */
  normal(count: number, mean = 0, stddev = 1): number[] {
    const position = this.reserve(count);
    const out = new Array<number>(count);
    for (let i = 0; i < count; i++) {
      const block = position.counter + (i >> 2);
      const words = philox4x32(position.key[0], position.key[1], block, 0);
      // Each block yields two normal pairs; pick the lane this element needs.
      const lane = i & 3;
      const pair =
        lane < 2
          ? normalFromBits(words[0]!, words[1]!)
          : normalFromBits(words[2]!, words[3]!);
      out[i] = mean + pair[lane % 2]! * stddev;
    }
    return out;
  }

  /** Sample `count` integers in `[lo, hi)` on the host. */
  integers(count: number, lo: number, hi: number): number[] {
    const position = this.reserve(count);
    const out = new Array<number>(count);
    for (let i = 0; i < count; i++) {
      const block = position.counter + (i >> 2);
      const words = philox4x32(position.key[0], position.key[1], block, 0);
      out[i] = intFromBits(words[i & 3]!, lo, hi);
    }
    return out;
  }
}

/**
 * Sample one element of a stream, given its position.
 *
 * Shared by the reference backend's random kernels so their output matches
 * {@link Generator}'s host sampling exactly.
 */
export function sampleAt(
  kind: 'uniform' | 'normal' | 'bernoulli' | 'randint',
  key: readonly [number, number],
  counter: number,
  index: number,
  attrs: { low?: number; high?: number; mean?: number; stddev?: number; p?: number },
): number {
  const block = counter + (index >> 2);
  const lane = index & 3;
  const words = philox4x32(key[0], key[1], block, 0);
  switch (kind) {
    case 'uniform': {
      const low = attrs.low ?? 0;
      const high = attrs.high ?? 1;
      return low + uniformFromBits(words[lane]!) * (high - low);
    }
    case 'normal': {
      const pair =
        lane < 2
          ? normalFromBits(words[0]!, words[1]!)
          : normalFromBits(words[2]!, words[3]!);
      return (attrs.mean ?? 0) + pair[lane % 2]! * (attrs.stddev ?? 1);
    }
    case 'bernoulli':
      return uniformFromBits(words[lane]!) < (attrs.p ?? 0.5) ? 1 : 0;
    case 'randint':
      return intFromBits(words[lane]!, attrs.low ?? 0, attrs.high ?? 2);
  }
}
