/**
 * internal:runtime/random — replaceable randomness for one Realm.
 *
 * Ordinary Realms use platform entropy. Deterministic execution can install a
 * seeded source for every runtime path that needs reproducible bytes. The
 * generator is independent of simulation policy and imports no I/O modules.
 *
 * @internal
 */

/** A source of random numbers and bytes. @internal */
export interface RandomSource {
  /** Return the next unsigned 32-bit value. */
  nextUint32(): number;
  /** Return the next double in the half-open interval `[0, 1)`. */
  nextFloat(): number;
  /** Fill `target` with bytes from this source. */
  fillBytes(target: Uint8Array): void;
}

const MASK_64 = (1n << 64n) - 1n;

function splitMix64(state: bigint): { value: bigint; next: bigint } {
  const next = (state + 0x9e3779b97f4a7c15n) & MASK_64;
  let value = next;
  value = ((value ^ (value >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK_64;
  value = ((value ^ (value >> 27n)) * 0x94d049bb133111ebn) & MASK_64;
  return { value: (value ^ (value >> 31n)) & MASK_64, next };
}

function normalizeSeed(seed: number | bigint | string): bigint {
  if (typeof seed === 'bigint') return seed & MASK_64;
  if (typeof seed === 'number') return BigInt(Math.floor(seed)) & MASK_64;

  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < seed.length; index++) {
    hash = (hash ^ BigInt(seed.charCodeAt(index))) & MASK_64;
    hash = (hash * 0x100000001b3n) & MASK_64;
  }
  return hash;
}

function rotateLeft(value: number, shift: number): number {
  return ((value << shift) | (value >>> (32 - shift))) >>> 0;
}

/**
 * Create a xoshiro128** source initialized from `seed`.
 *
 * Equal numeric, bigint, or string seeds always produce equal sequences.
 * String seeds are folded with FNV-1a before SplitMix64 expands the state.
 *
 * @internal
 */
export function createSeededRandom(seed: number | bigint | string): RandomSource {
  let state = normalizeSeed(seed);
  const lanes: number[] = [];
  while (lanes.length < 4) {
    const step = splitMix64(state);
    state = step.next;
    lanes.push(Number(step.value & 0xffffffffn) >>> 0);
    lanes.push(Number((step.value >> 32n) & 0xffffffffn) >>> 0);
  }

  let [s0, s1, s2, s3] = lanes as [number, number, number, number];
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;

  function nextUint32(): number {
    const result = Math.imul(rotateLeft(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const shifted = (s1 << 9) >>> 0;
    s2 = (s2 ^ s0) >>> 0;
    s3 = (s3 ^ s1) >>> 0;
    s1 = (s1 ^ s2) >>> 0;
    s0 = (s0 ^ s3) >>> 0;
    s2 = (s2 ^ shifted) >>> 0;
    s3 = rotateLeft(s3, 11);
    return result;
  }

  return {
    nextUint32,
    nextFloat(): number {
      const high = nextUint32() >>> 5;
      const low = nextUint32() >>> 6;
      return (high * 67108864 + low) / 9007199254740992;
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

let installedOverride: RandomSource | null = null;

/** Install a Realm-local source, or restore platform entropy with `null`. @internal */
export function setRandomOverride(source: RandomSource | null): void {
  installedOverride = source;
}

/** Return the installed Realm-local source, if any. @internal */
export function randomOverride(): RandomSource | null {
  return installedOverride;
}
