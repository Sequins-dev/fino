// A test file whose body fails with a falsy value, which used to be indistinguishable
// from success. Run through a child process by tests/test-runner.test.ts.
//
// Nothing follows the throw. An earlier version registered a `describe` after it to
// show that the file never gets that far, which was true and also unreachable code —
// the linter said so, correctly, the first time it ever ran over this branch.
import 'fino:test/test';

throw undefined;
