/**
 * Runtime module-loader coverage for TSX and JSX files.
 */
import { describe, it } from 'fino:test/test';
describe('JSX module loading', () => {
  it('loads TSX compiled into the builtin source bundle', async (t) => {
    const module = await import('internal:fixtures/tsx-builtin');
    t.equal(module.builtinTsxFixture.type, 'text', 'builtin JSX produces a Fino VNode');
    t.equal(
      module.builtinTsxFixture.props['data-source'],
      'builtin',
      'builtin JSX attributes become VNode props',
    );
    t.deepEqual(
      module.builtinTsxFixture.children,
      ['TSX builtin'],
      'builtin JSX children are normalized',
    );
  });
  it('loads TSX through the Fino automatic JSX runtime', async (t) => {
    const module = await import('../fixtures/typescript-view.tsx');
    t.equal(module.greeting.type, 'h1', 'component produces a Fino VNode');
    t.equal(module.greeting.props.class, 'greeting', 'JSX attributes become VNode props');
    t.deepEqual(module.greeting.children, ['Hello, ', 'Fino'], 'JSX children are normalized');
  });
  it('loads JSX files and probes the extension', async (t) => {
    const module = await import('../fixtures/javascript-view');
    t.equal(module.badge.type, 'span', 'extension-probed JSX produces a Fino VNode');
    t.equal(module.badge.props['data-kind'], 'badge', 'JSX preserves data attributes');
  });
});
