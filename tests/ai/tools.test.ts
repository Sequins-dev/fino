import { describe, it } from 'fino:test/test';
import {
  createWorkspaceTools,
  editFileTool,
  listFilesTool,
  readFileTool,
  searchFilesTool,
  shellTool,
  writeFileTool,
} from 'fino:ai/tools';
import type { Tool, ToolRunContext } from 'fino:ai/tool';
import { DiskFileSystem } from 'fino:file';
const fs = new DiskFileSystem();
const encoder = new TextEncoder();
function toolCtx(): ToolRunContext {
  return {
    signal: AbortSignal.timeout(30e3),
    toolCallId: 'call_test',
    step: 0,
    runId: 'run_test',
    messages: [],
    suspend(): never {
      throw new Error('suspend unsupported in this test');
    },
  };
}
let tempCounter = 0;
async function tempDir(): Promise<string> {
  const dir = `/tmp/fino-ai-tools-test-${Date.now().toString(36)}-${tempCounter++}`;
  await fs.mkdir(dir);
  return dir;
}
function byName(tools: Tool[]): Map<string, Tool> {
  return new Map(tools.map((entry) => [entry.name, entry]));
}
describe('fino:ai/tools — workspace tool set', () => {
  it('lists the read-only tools then the mutating tools by default', (t) => {
    const names = createWorkspaceTools({ cwd: '/tmp' }).map((entry) => entry.name);
    t.deepEqual(names, [
      'list_files',
      'read_file',
      'search_files',
      'write_file',
      'edit_file',
      'shell',
    ]);
  });
  it('omits the mutating tools when writes is disabled', (t) => {
    const names = createWorkspaceTools({ cwd: '/tmp', writes: false }).map((entry) => entry.name);
    t.deepEqual(names, ['list_files', 'read_file', 'search_files']);
  });
  it('gates the mutating tools behind approval unless auto is set', (t) => {
    const gated = byName(createWorkspaceTools({ cwd: '/tmp' }));
    const auto = byName(createWorkspaceTools({ cwd: '/tmp', auto: true }));
    for (const name of ['write_file', 'edit_file', 'shell']) {
      t.equal(gated.get(name)!.requiresApproval, true, `${name} requires approval by default`);
      t.ok(!auto.get(name)!.requiresApproval, `${name} skips approval with auto`);
    }
    for (const name of ['list_files', 'read_file', 'search_files']) {
      t.ok(!gated.get(name)!.requiresApproval, `${name} is never gated`);
    }
  });
  it('exposes each tool as its own factory', (t) => {
    const cwd = '/tmp';
    t.equal(listFilesTool({ cwd }).name, 'list_files');
    t.equal(readFileTool({ cwd }).name, 'read_file');
    t.equal(searchFilesTool({ cwd }).name, 'search_files');
    t.equal(writeFileTool({ cwd }).name, 'write_file');
    t.equal(editFileTool({ cwd }).name, 'edit_file');
    t.equal(shellTool({ cwd, auto: true }).name, 'shell');
    t.ok(!shellTool({ cwd, auto: true }).requiresApproval, 'individual factory honours auto');
  });
  it('reads, lists, and searches a real directory', async (t) => {
    const dir = await tempDir();
    await fs.mkdir(`${dir}/src`);
    await fs.writeFile(
      `${dir}/src/a.ts`,
      encoder.encode('export const n = 1;\nconst other = 2;\n'),
    );

    const read = await readFileTool({ cwd: dir }).invoke({ path: 'src/a.ts' }, toolCtx());
    t.ok(!read.isError, 'read succeeds');
    t.ok(String(read.content).includes('    1\texport const n = 1;'), 'read numbers lines');

    const paged = await readFileTool({ cwd: dir }).invoke(
      { path: 'src/a.ts', offset: 2, limit: 1 },
      toolCtx(),
    );
    t.ok(String(paged.content).startsWith('    2\t'), 'offset selects the second line');

    const list = await listFilesTool({ cwd: dir }).invoke({ pattern: 'src/**' }, toolCtx());
    t.equal(String(list.content), 'src/a.ts', 'list reports paths relative to cwd');

    const search = await searchFilesTool({ cwd: dir }).invoke(
      { pattern: 'const n = \\d' },
      toolCtx(),
    );
    t.ok(String(search.content).includes('src/a.ts:1:'), 'search reports path:line');

    const noMatch = await searchFilesTool({ cwd: dir }).invoke({ pattern: 'zzzz' }, toolCtx());
    t.equal(String(noMatch.content), 'No matches for /zzzz/', 'empty search says so');
  });
  it('reaches outside the workspace root unless confined', async (t) => {
    // An agent on a real machine reads scratch files and neighbouring
    // checkouts, so the tools follow absolute paths by default.
    const dir = await tempDir();
    const outside = `${dir}-outside.txt`;
    await fs.writeFile(outside, encoder.encode('secret\n'));

    const read = await readFileTool({ cwd: dir }).invoke({ path: outside }, toolCtx());
    t.ok(!read.isError, 'an absolute path outside cwd is read by default');
    t.ok(String(read.content).includes('secret'), 'the outside file comes back');
  });

  it('refuses paths outside the workspace root when confined', async (t) => {
    const dir = await tempDir();
    const outside = `${dir}-outside.txt`;
    await fs.writeFile(outside, encoder.encode('secret\n'));

    const read = await readFileTool({ cwd: dir, confine: true }).invoke(
      { path: outside },
      toolCtx(),
    );
    t.equal(read.isError, true, 'absolute path outside cwd is refused');
    t.ok(String(read.content).includes('outside the workspace root'), 'explains the refusal');

    const climbed = await readFileTool({ cwd: dir, confine: true }).invoke(
      { path: '../../etc/passwd' },
      toolCtx(),
    );
    t.equal(climbed.isError, true, 'relative climb out of cwd is refused');

    const written = await writeFileTool({ cwd: dir, auto: true, confine: true }).invoke(
      { path: outside, content: 'overwritten\n' },
      toolCtx(),
    );
    t.equal(written.isError, true, 'write outside cwd is refused');
    t.equal(
      new TextDecoder().decode(await fs.readFile(outside)),
      'secret\n',
      'the outside file is untouched',
    );

    await fs.writeFile(`${dir}/in.txt`, encoder.encode('allowed\n'));
    const inside = await readFileTool({ cwd: dir, confine: true }).invoke(
      { path: `${dir}/in.txt` },
      toolCtx(),
    );
    t.ok(!inside.isError, 'absolute paths inside cwd are allowed');
    t.ok(String(inside.content).includes('allowed'), 'inside read returns the file');
  });
  it('writes and edits files in place', async (t) => {
    const dir = await tempDir();
    const write = writeFileTool({ cwd: dir, auto: true });
    const edit = editFileTool({ cwd: dir, auto: true });

    const created = await write.invoke(
      { path: 'nested/a.ts', content: 'export const n = 1;\n' },
      toolCtx(),
    );
    t.ok(!created.isError, 'write creates parent directories');

    const edited = await edit.invoke(
      { path: 'nested/a.ts', oldText: 'n = 1', newText: 'n = 2' },
      toolCtx(),
    );
    t.ok(!edited.isError, 'edit succeeds');
    t.equal(
      new TextDecoder().decode(await fs.readFile(`${dir}/nested/a.ts`)),
      'export const n = 2;\n',
      'edit lands on disk',
    );

    await write.invoke({ path: 'b.txt', content: 'x x\n' }, toolCtx());
    const ambiguous = await edit.invoke({ path: 'b.txt', oldText: 'x', newText: 'y' }, toolCtx());
    t.equal(ambiguous.isError, true, 'ambiguous match is an error');
    const all = await edit.invoke(
      { path: 'b.txt', oldText: 'x', newText: 'y', replaceAll: true },
      toolCtx(),
    );
    t.ok(!all.isError, 'replaceAll resolves ambiguity');
    const missing = await edit.invoke({ path: 'b.txt', oldText: 'zzz', newText: 'y' }, toolCtx());
    t.equal(missing.isError, true, 'missing match is an error');
  });
  it('runs shell commands from the workspace root', async (t) => {
    const dir = await tempDir();
    await fs.writeFile(`${dir}/marker.txt`, encoder.encode('here\n'));
    const shell = shellTool({ cwd: dir, auto: true });
    const ok = await shell.invoke({ command: 'ls' }, toolCtx());
    t.ok(String(ok.content).includes('marker.txt'), 'command runs in cwd');
    const failed = await shell.invoke({ command: 'exit 7' }, toolCtx());
    t.equal(failed.isError, true, 'non-zero exit is a tool error');
    t.ok(String(failed.content).includes('exit code: 7'), 'exit code reported');
  });
});
