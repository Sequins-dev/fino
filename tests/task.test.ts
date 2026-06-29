import { describe, it } from 'fino:test/test';
import { Task, task } from 'fino:task';

const inputSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
  },
  required: ['name'],
};

describe('fino:task', () => {
  it('runs validated task input and exposes task metadata', async (t) => {
    const greet = task({
      name: 'greet',
      description: 'Greet a person',
      inputSchema,
      outputMode: 'both',
      run: (input: { name: string }, ctx) => {
        if (ctx.writer.mode === 'json') ctx.writer.writeJson({ greeting: `hello ${input.name}` });
        else ctx.writer.writeText(`hello ${input.name}\n`);
        return { greeting: `hello ${input.name}` };
      },
    });

    const chunks: unknown[] = [];
    const result = await greet.run({ name: 'Ada' }, {
      outputMode: 'json',
      writer: { mode: 'json', writeJson: (value) => { chunks.push(value); } },
    });

    t.ok(greet instanceof Task, 'factory returns a Task');
    t.equal(greet.name, 'greet');
    t.equal(greet.description, 'Greet a person');
    t.deepEqual(chunks, [{ greeting: 'hello Ada' }]);
    t.deepEqual(result, { greeting: 'hello Ada' });
  });

  it('rejects unsupported output modes before executing', async (t) => {
    let ran = false;
    const textOnly = task({
      name: 'text_only',
      outputMode: 'text',
      run: () => {
        ran = true;
        return 'ok';
      },
    });

    await t.rejects(
      () => textOnly.run({}, {
        outputMode: 'json',
        writer: { mode: 'json', writeJson: () => undefined },
      }),
      /does not support json output/,
    );
    t.equal(ran, false, 'handler was not called');
  });

  it('rejects mismatched requested and writer output modes', async (t) => {
    const both = task({
      name: 'both',
      outputMode: 'both',
      run: () => 'ok',
    });

    await t.rejects(
      () => both.run({}, {
        outputMode: 'json',
        writer: { mode: 'text', writeText: () => undefined },
      }),
      /writer mode text does not match requested json output/,
    );
  });

  it('parses nested CLI tasks and honors global --json', async (t) => {
    const build = task({
      name: 'build',
      outputMode: 'both',
      cli: {
        options: [{ name: 'outDir', flags: '--out-dir', type: 'string' }],
        positionals: [{ name: 'entry', required: true }],
      },
      run: (input: Record<string, unknown>, ctx) => {
        if (ctx.writer.mode === 'json') ctx.writer.writeJson({ input });
        else ctx.writer.writeText(`${input.entry}:${input.outDir}\n`);
        return input;
      },
    });
    const doc = task({ name: 'doc', children: [build], run: () => undefined });

    const seen: unknown[] = [];
    const result = await doc.parse(['--json', 'build', '--out-dir', 'api', 'index.ts'], {
      writer: { mode: 'json', writeJson: (value) => { seen.push(value); } },
    });

    t.deepEqual(result, { entry: 'index.ts', outDir: 'api' });
    t.deepEqual(seen, [{ input: { entry: 'index.ts', outDir: 'api' } }]);
  });

  it('lists and looks up child tasks', (t) => {
    const child = task({ name: 'child', run: () => 'ok' });
    const parent = task({ name: 'parent', children: [child], run: () => 'parent' });

    t.equal(parent.child('child'), child);
    t.deepEqual(parent.list(), [child]);
    t.ok(parent.help().includes('child'), 'help includes child task names');
  });
});
