/**
 * Tests for TypeScript support.
 *
 * Verifies that .ts files are type-stripped before evaluation, that
 * import.meta reflects the original .ts path, and that extension
 * probing finds .ts files when no extension is given.
 */

import { describe, it } from 'fino:test/test';
import { add, identity, Stack, origin } from '../fixtures/typescript-sample.ts';
import { throwFromTypedTs } from '../fixtures/source-map-throw.ts';

const meta = import.meta as ImportMeta & {
  filename: string;
};
const typescriptSampleSpecifier = '../fixtures/typescript-sample';

describe('type stripping', () => {
  it('strips function parameter types', (t) => {
    t.equal(add(2, 3), 5, 'add(2, 3) === 5');
  });

  it('strips generic type parameters', (t) => {
    t.equal(identity('hello'), 'hello', 'identity works with string');
    t.equal(identity(42), 42, 'identity works with number');
  });

  it('strips class field type annotations', (t) => {
    const stack = new Stack();
    stack.push(1);
    stack.push(2);
    t.equal(stack.size, 2, 'stack has 2 items');
    t.equal(stack.pop(), 2, 'pop returns last item');
    t.equal(stack.size, 1, 'stack has 1 item after pop');
  });

  it('strips interface declarations', (t) => {
    t.equal(origin.x, 0, 'origin.x === 0');
    t.equal(origin.y, 0, 'origin.y === 0');
  });

  it('strips type-only exports', (t) => {
    // The `export type { Point }` should be stripped; Point is not a value
    t.equal(typeof origin, 'object', 'origin is an object (interface only used as type)');
  });
});

describe('import.meta for .ts modules', () => {
  it('import.meta.filename ends with .ts', (t) => {
    t.ok(meta.filename.endsWith('typescript.test.mts'), 'test file filename is correct');
  });
});

describe('extension probing', () => {
  it('resolves .ts file when imported without extension', async (t) => {
    // Import specifier has no extension — the resolver should probe .ts
    const m = await import(typescriptSampleSpecifier);
    t.equal(m.add(1, 2), 3, 'extension-probed import evaluates correctly');
  });
});

describe('source maps', () => {
  it('maps thrown stack traces back to the original ts source', (t) => {
    let err = null;
    try {
      throwFromTypedTs();
    } catch (caught) {
      err = caught;
    }

    t.ok(err instanceof Error, 'throws an Error');
    const error = err as Error;
    t.ok(error.stack?.includes('source-map-throw.ts:18') === true, 'stack points at original ts line');
  });

  it('maps builtin stack traces back to the original mts source', (t) => {
    let err = null;
    try {
      queueMicrotask(42 as any);
    } catch (caught) {
      err = caught;
    }

    t.ok(err instanceof Error, 'throws an Error');
    const error = err as Error;
    t.ok(/js\/internal\/globals\/time\.mts:\d+/.test(error.stack ?? ''), 'stack points at original builtin mts file');
  });
});
