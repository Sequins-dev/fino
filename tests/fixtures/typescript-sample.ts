// TypeScript fixture used by typescript.test.mjs.
// All type annotations here should be stripped before Boa evaluates the module.

interface Point {
  x: number;
  y: number;
}

function add(a: number, b: number): number {
  return a + b;
}

function identity<T>(value: T): T {
  return value;
}

class Stack<T> {
  #items: T[] = [];

  push(item: T): void {
    this.#items.push(item);
  }

  pop(): T | undefined {
    return this.#items.pop();
  }

  get size(): number {
    return this.#items.length;
  }
}

const origin: Point = { x: 0, y: 0 };

export { add, identity, Stack, origin };
export type { Point };
