/**
 * Kernel identity: specialization keys and content hashing.
 *
 * A template is a deterministic pure function of its specialization parameters,
 * so the parameters *are* the kernel's identity — there is no need to serialize
 * and hash the emitted IR. Every field that changes emitted code must appear in
 * the key, and nothing else may.
 *
 * Collisions are made harmless rather than merely unlikely: the cache stores the
 * full key text alongside the artifact and compares it on read, so the hash is
 * only a file name.
 *
 * @internal
 *
 * This module is re-exported through `internal:tensor/ir`; import from there.
 */

/**
 * Version of the IR, templates, and lowerings taken together.
 *
 * Bump on any change that could alter emitted code. A forgotten bump costs a
 * cold cache once the fino build version also changes, never a stale kernel.
 */
export const IR_CODEGEN_VERSION = 1;

/** 2^64 - 1, for wrapping the FNV state. */
const MASK64 = 0xffffffffffffffffn;

/** The 64-bit FNV-1a prime. */
const FNV_PRIME = 0x100000001b3n;

/**
 * FNV-1a over 64 bits, rendered as 16 hex digits.
 *
 * Runs once per kernel compile rather than per dispatch, so `BigInt` is the
 * right trade: a hand-rolled 32-bit limb multiply would be faster and much
 * harder to be sure of.
 *
 * Hashes UTF-8 bytes, so keys containing non-ASCII text hash consistently.
 */
export function fnv1a64(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of new TextEncoder().encode(text)) {
    hash = ((hash ^ BigInt(byte)) * FNV_PRIME) & MASK64;
  }
  return hash.toString(16).padStart(16, '0');
}

/** Fields that identify one compiled artifact. */
export interface CacheKeyParts {
  /** The template's specialization key. */
  spec: string;
  /** Target dialect and capability bits, e.g. `msl-3.0` or `spirv-1.3+f16`. */
  target: string;
  /** Compiler identity, where the target has an external compiler. */
  compiler?: string;
  /** Compilation flags that change generated code. */
  flags?: string;
}

/**
 * Build the full cache key.
 *
 * Fields are joined with a unit separator so no two distinct field combinations
 * can render to the same text.
 */
export function cacheKeyText(parts: CacheKeyParts): string {
  return [
    parts.spec,
    parts.target,
    `ir${IR_CODEGEN_VERSION}`,
    parts.compiler ?? '-',
    parts.flags ?? '-',
  ].join('');
}

/** Hash of {@link cacheKeyText}, used as a file name. */
export function cacheKeyHash(parts: CacheKeyParts): string {
  return fnv1a64(cacheKeyText(parts));
}

/**
 * Join specialization fields into a key fragment.
 *
 * Undefined values are dropped so optional flags do not perturb keys for
 * kernels that never set them, and `false` is dropped for the same reason.
 */
export function specKey(
  template: string,
  fields: Readonly<Record<string, string | number | boolean | undefined>>,
): string {
  const parts: string[] = [template];
  for (const name of Object.keys(fields).sort()) {
    const value = fields[name];
    if (value === undefined || value === false) continue;
    parts.push(value === true ? name : `${name}=${value}`);
  }
  return parts.join('|');
}
