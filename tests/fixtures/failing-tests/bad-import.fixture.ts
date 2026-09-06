// A test file that cannot load. Imported by tests/test-runner.test.ts through a child
// process; it is not part of any suite run directly.
import { describe, it } from 'fino:test/test';
import { missing } from 'fino:no-such-module-exists';
describe('never runs', () => {
  it('never runs', (t) => t.ok(missing));
});
