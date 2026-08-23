import { describe, it } from 'fino:test/test';
import { Task } from 'fino:task';
import benchCommand from 'internal:commands/bench';
import coverageCommand from 'internal:commands/coverage';
import docCommand from 'internal:commands/doc';
import fmtCommand from 'internal:commands/fmt';
import initCommand from 'internal:commands/init';
import installCommand from 'internal:commands/install';
import lintCommand from 'internal:commands/lint';
import loadCommand from 'internal:commands/load';
import replCommand from 'internal:commands/repl';
import rootCommand from 'internal:commands/root';
import runCommand from 'internal:commands/run';
import taskCommand from 'internal:commands/task';
import testCommand from 'internal:commands/test';
describe('builtin command tasks', () => {
  it('exposes only default Task exports through public command modules', async (t) => {
    const modules = [
      await import('fino:commands/root'),
      await import('fino:commands/run'),
      await import('fino:commands/test'),
      await import('fino:commands/coverage'),
      await import('fino:commands/bench'),
      await import('fino:commands/load'),
      await import('fino:commands/install'),
      await import('fino:commands/init'),
      await import('fino:commands/doc'),
      await import('fino:commands/fmt'),
      await import('fino:commands/lint'),
      await import('fino:commands/task'),
      await import('fino:commands/repl'),
    ];
    for (const mod of modules) t.deepEqual(Object.keys(mod), ['default']);
    const commands = modules.map((mod) => mod.default);
    t.deepEqual(
      commands.map((command) => command.name),
      [
        'fino',
        'run',
        'test',
        'coverage',
        'bench',
        'load',
        'install',
        'init',
        'doc',
        'fmt',
        'lint',
        'task',
        'repl',
      ],
    );
    for (const command of commands) t.ok(command instanceof Task, `${command.name} is a Task`);
  });
  it('exposes every internal compatibility command as a default Task', (t) => {
    const commands = [
      rootCommand,
      runCommand,
      testCommand,
      coverageCommand,
      benchCommand,
      loadCommand,
      installCommand,
      initCommand,
      docCommand,
      fmtCommand,
      lintCommand,
      taskCommand,
      replCommand,
    ];
    for (const command of commands) t.ok(command instanceof Task, `${command.name} is a Task`);
  });
  it('exposes focused coverage subcommands as nested Tasks', (t) => {
    t.deepEqual(
      coverageCommand.list().map((task) => task.name),
      ['summary', 'files', 'lines', 'functions', 'branches', 'realms', 'realm', 'check', 'export'],
    );
    for (const child of coverageCommand.list())
      t.ok(child instanceof Task, `${child.name} is a Task`);
  });
  it('exposes doc subcommands as nested Tasks', (t) => {
    t.deepEqual(
      docCommand.list().map((task) => task.name),
      ['build', 'show', 'search', 'test'],
    );
    for (const child of docCommand.list()) t.ok(child instanceof Task, `${child.name} is a Task`);
  });
});
