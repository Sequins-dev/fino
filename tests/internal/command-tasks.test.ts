import { describe, it } from 'fino:test/test';
import { Task } from 'fino:task';
import { createBenchCommand } from 'internal:commands/bench';
import { createDocCommand } from 'internal:commands/doc';
import { createFmtCommand } from 'internal:commands/fmt';
import { createInitCommand } from 'internal:commands/init';
import { createInstallCommand } from 'internal:commands/install';
import { createLintCommand } from 'internal:commands/lint';
import { createReplCommand } from 'internal:commands/repl';
import { createRootCommand } from 'internal:commands/root';
import { createRunCommand } from 'internal:commands/run';
import { createTestCommand } from 'internal:commands/test';

describe('builtin command tasks', () => {
  it('exposes every builtin CLI command as a Task', (t) => {
    const commands = [
      createRootCommand(),
      createRunCommand(),
      createTestCommand(),
      createBenchCommand(),
      createInstallCommand(),
      createInitCommand(),
      createDocCommand(),
      createFmtCommand(),
      createLintCommand(),
      createReplCommand(),
    ];

    for (const command of commands) t.ok(command instanceof Task, `${command.name} is a Task`);
  });

  it('exposes doc subcommands as nested Tasks', (t) => {
    const doc = createDocCommand();
    t.deepEqual(doc.list().map((task) => task.name), ['build', 'show', 'search', 'test']);
    for (const child of doc.list()) t.ok(child instanceof Task, `${child.name} is a Task`);
  });
});
