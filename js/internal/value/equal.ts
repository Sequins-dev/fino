/**
 * internal:value/equal — structural equality for cloneable runtime values.
 *
 * This is the shared comparison mechanism used where identity is deliberately
 * broken by `structuredClone()`. It compares enumerable object structure,
 * cyclic graphs, maps, sets, dates, regular expressions, array buffers, data
 * views, and typed arrays. Prototype identity and non-enumerable properties are
 * not part of the contract.
 *
 * @internal
 */

type RecordValue = Record<string | symbol, unknown>;

function record(value: unknown): value is RecordValue {
  return typeof value === 'object' && value !== null;
}

function compared(seen: WeakMap<object, WeakSet<object>>, left: object, right: object): boolean {
  const matches = seen.get(left);
  if (matches?.has(right)) return true;
  if (matches) matches.add(right);
  else seen.set(left, new WeakSet([right]));
  return false;
}

function enumerableKeys(value: object): Array<string | symbol> {
  const keys: Array<string | symbol> = Object.keys(value);
  for (const symbol of Object.getOwnPropertySymbols(value)) {
    if (Object.prototype.propertyIsEnumerable.call(value, symbol)) keys.push(symbol);
  }
  return keys;
}

function bytes(value: ArrayBuffer | SharedArrayBuffer | ArrayBufferView): Uint8Array {
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return new Uint8Array(value);
}

function equalBytes(
  left: ArrayBuffer | SharedArrayBuffer | ArrayBufferView,
  right: ArrayBuffer | SharedArrayBuffer | ArrayBufferView,
): boolean {
  if (left.constructor !== right.constructor || left.byteLength !== right.byteLength) return false;
  const leftBytes = bytes(left);
  const rightBytes = bytes(right);
  for (let index = 0; index < leftBytes.length; index++) {
    if (leftBytes[index] !== rightBytes[index]) return false;
  }
  return true;
}

function equalMaps(
  left: Map<unknown, unknown>,
  right: Map<unknown, unknown>,
  seen: WeakMap<object, WeakSet<object>>,
): boolean {
  if (left.size !== right.size) return false;
  const matched = new Set<unknown>();
  for (const [leftKey, leftValue] of left) {
    let found = false;
    for (const [rightKey, rightValue] of right) {
      if (matched.has(rightKey)) continue;
      if (deepEqual(leftKey, rightKey, seen) && deepEqual(leftValue, rightValue, seen)) {
        matched.add(rightKey);
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

function equalSets(
  left: Set<unknown>,
  right: Set<unknown>,
  seen: WeakMap<object, WeakSet<object>>,
): boolean {
  if (left.size !== right.size) return false;
  const matched = new Set<unknown>();
  for (const leftValue of left) {
    let found = false;
    for (const rightValue of right) {
      if (matched.has(rightValue)) continue;
      if (deepEqual(leftValue, rightValue, seen)) {
        matched.add(rightValue);
        found = true;
        break;
      }
    }
    if (!found) return false;
  }
  return true;
}

/** Compare two values by cloneable structure rather than object identity. @internal */
export function deepEqual(
  left: unknown,
  right: unknown,
  seen: WeakMap<object, WeakSet<object>> = new WeakMap(),
): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== typeof right) return false;
  if (!record(left) || !record(right)) return false;
  if (compared(seen, left, right)) return true;
  if (left instanceof Date || right instanceof Date) {
    return (
      left instanceof Date && right instanceof Date && Object.is(left.getTime(), right.getTime())
    );
  }
  if (left instanceof RegExp || right instanceof RegExp) {
    return (
      left instanceof RegExp &&
      right instanceof RegExp &&
      left.source === right.source &&
      left.flags === right.flags
    );
  }
  if (left instanceof Map || right instanceof Map) {
    return left instanceof Map && right instanceof Map && equalMaps(left, right, seen);
  }
  if (left instanceof Set || right instanceof Set) {
    return left instanceof Set && right instanceof Set && equalSets(left, right, seen);
  }
  if (
    left instanceof ArrayBuffer ||
    right instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== 'undefined' && left instanceof SharedArrayBuffer) ||
    (typeof SharedArrayBuffer !== 'undefined' && right instanceof SharedArrayBuffer) ||
    ArrayBuffer.isView(left) ||
    ArrayBuffer.isView(right)
  ) {
    const leftBytes =
      left instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== 'undefined' && left instanceof SharedArrayBuffer) ||
      ArrayBuffer.isView(left)
        ? left
        : null;
    const rightBytes =
      right instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== 'undefined' && right instanceof SharedArrayBuffer) ||
      ArrayBuffer.isView(right)
        ? right
        : null;
    return leftBytes !== null && rightBytes !== null && equalBytes(leftBytes, rightBytes);
  }
  const leftKeys = enumerableKeys(left);
  const rightKeys = enumerableKeys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  for (const key of leftKeys) {
    if (!Object.prototype.hasOwnProperty.call(right, key)) return false;
    if (!deepEqual(left[key], right[key], seen)) return false;
  }
  return true;
}
