// A test file whose body fails with a falsy value, which used to be indistinguishable
// from success. Run through a child process by tests/test-runner.test.ts.
import { describe, it } from 'fino:test/test';
throw undefined;
describe('never runs', () => {
  it('never runs', (t) => t.ok(true));
});
