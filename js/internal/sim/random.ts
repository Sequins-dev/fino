/**
 * internal:sim/random — seeded randomness for a realm.
 *
 * Provides a xoshiro128** generator seeded through splitmix64, plus the
 * realm-wide slot that `Math.random`, `crypto.getRandomValues`, and
 * `fino:security/random` read from when a simulation is active. Like
 * `internal:sim/clock` this module imports nothing, so seeding a realm never
 * depends on guest-visible I/O.
 *
 * xoshiro128** is chosen because its state is four 32-bit words, which
 * JavaScript can advance exactly with `Math.imul` and shifts — no BigInt in the
 * hot path, so a seeded realm pays nothing measurable per draw. Seeding runs
 * splitmix64 once, where BigInt cost is irrelevant.
 *
 * ```ts no_run
 * import { createSeededRandom } from 'internal:sim/random';
 *
 * const rng = createSeededRandom(42);
 * console.log(rng.nextFloat() === createSeededRandom(42).nextFloat()); // true
 * ```
 *
 * @internal
 */
/**
 * A deterministic source of random values.
 *
 * @internal
 */
export interface RandomSource {
  /** Next raw 32-bit draw. */
  nextUint32(): number;
  /** Next double in [0, 1) with 53 bits of entropy. */
  nextFloat(): number;
  /** Fill `target` with pseudo-random bytes. */
  fillBytes(target: Uint8Array): void;
}
const _MASK64 = (1n << 64n) - 1n;
/**
 * One splitmix64 step. Used only to expand a seed into generator state.
 */
function _splitmix64(state: bigint): { value: bigint; next: bigint } {
  const next = (state + 0x9e3779b97f4a7c15n) & _MASK64;
  let z = next;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & _MASK64;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & _MASK64;
  return { value: (z ^ (z >> 31n)) & _MASK64, next };
}
/**
 * Fold an arbitrary seed value into the 64 bits splitmix64 expects.
 *
 * Strings are hashed with FNV-1a so a named simulation seeds reproducibly.
 */
function _normalizeSeed(seed: number | bigint | string): bigint {
  if (typeof seed === 'bigint') return seed & _MASK64;
  if (typeof seed === 'number') return BigInt(Math.floor(seed)) & _MASK64;
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash ^ BigInt(seed.charCodeAt(index))) & _MASK64;
    hash = (hash * 0x100000001b3n) & _MASK64;
  }
  return hash;
}
function _rotl(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}
/**
 * Create a xoshiro128** generator from `seed`.
 *
 * Equal seeds always produce equal sequences, which is what makes a simulation
 * run reproducible.
 *
 * ```ts no_run
 * import { createSeededRandom } from 'internal:sim/random';
 *
 * const rng = createSeededRandom('checkout-flow');
 * console.log(rng.nextUint32());
 * ```
 *
 * @internal
 */
export function createSeededRandom(seed: number | bigint | string): RandomSource {
  let expander = _normalizeSeed(seed);
  const lanes: number[] = [];
  while (lanes.length < 4) {
    const step = _splitmix64(expander);
    expander = step.next;
    lanes.push(Number(step.value & 0xffffffffn) >>> 0);
    lanes.push(Number((step.value >> 32n) & 0xffffffffn) >>> 0);
  }
  let [s0, s1, s2, s3] = lanes as [number, number, number, number];
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;
  function nextUint32(): number {
    const result = Math.imul(_rotl(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ t) >>> 0;
    s3 = _rotl(s3, 11);
    return result;
  }
  return {
    nextUint32,
    nextFloat(): number {
      // 53 significant bits, matching the precision of a JS double.
      const hi = nextUint32() >>> 5;
      const lo = nextUint32() >>> 6;
      return (hi * 67108864 + lo) / 9007199254740992;
    },
    fillBytes(target: Uint8Array): void {
      let index = 0;
      while (index < target.length) {
        let word = nextUint32();
        for (let byte = 0; byte < 4 && index < target.length; byte++) {
          target[index++] = word & 0xff;
          word >>>= 8;
        }
      }
    },
  };
}
let _source: RandomSource | null = null;
/**
 * Install or remove the realm's seeded source. `null` restores real entropy.
 *
 * @internal
 */
export function setRandomSource(source: RandomSource | null): void {
  _source = source;
}
/**
 * The installed seeded source, or `null` when the realm uses real entropy.
 *
 * @internal
 */
export function randomSource(): RandomSource | null {
  return _source;
}
