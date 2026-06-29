/**
* TypeScript sample module used by tests/internal/typescript.test.ts.
* Exercises type-stripping: typed functions, generics, class field annotations,
* interface declarations, and type-only exports.
*/
interface Point {
  x: number;
  y: number;
}
export function add(a: number, b: number): number {
  return a + b;
}
export function identity<T>(val: T): T {
  return val;
}
export class Stack<T> {
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
export const origin: Point = {
  x: 0,
  y: 0
};
export type { Point };
