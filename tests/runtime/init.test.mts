/**
 * Integration tests for `fino init`.
 */

import { after, before, describe, it } from 'fino:test/test';
import { DiskFileSystem } from 'fino:file';
import { Process, execPath } from 'fino:process';

const TEST_DIR = '/tmp/fino-init-test-' + Math.floor(Math.random() * 1_000_000);

interface PackageJsonShape {
  name: string;
  version: string;
  type: string;
  description: string;
  license: string;
  author: string;
  repository: string;
}

function decodeUtf8(b: ArrayBuffer | ArrayBufferView): string {
  return new TextDecoder().decode(b);
}

async function readAll(reader: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of reader) chunks.push(chunk);
  return decodeUtf8(chunks.reduce((acc: Uint8Array, c: Uint8Array) => {
    const merged = new Uint8Array(acc.byteLength + c.byteLength);
    merged.set(acc);
    merged.set(c, acc.byteLength);
    return merged;
  }, new Uint8Array(0)));
}

async function exists(fs: DiskFileSystem, path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch (_) {
    return false;
  }
}

async function removeTree(fs: DiskFileSystem, path: string): Promise<void> {
  if (!(await exists(fs, path))) return;
  const entry = await fs.entry(path);
  if (entry.isDirectory()) {
    const dir = await fs.dir(path);
    for (const child of await dir.entries()) await removeTree(fs, child.path.toString());
    await fs.rmdir(path);
    return;
  }
  await fs.unlink(path);
}

async function runCli(args: string[], cwd: string): Promise<{ stdout: string; stderr: string; result: Awaited<ReturnType<Process['wait']>> }> {
  const proc = new Process(execPath, args, { cwd });
  proc.stdin.close();
  const [stdout, stderr, result] = await Promise.all([
    readAll(proc.stdout),
    readAll(proc.stderr),
    proc.wait(),
  ]);
  return { stdout, stderr, result };
}

async function runCliWithEnv(args: string[], cwd: string, env: Record<string, string>): Promise<{ stdout: string; stderr: string; result: Awaited<ReturnType<Process['wait']>> }> {
  const proc = new Process(execPath, args, { cwd, env });
  proc.stdin.close();
  const [stdout, stderr, result] = await Promise.all([
    readAll(proc.stdout),
    readAll(proc.stderr),
    proc.wait(),
  ]);
  return { stdout, stderr, result };
}

async function runCommand(command: string, args: string[], cwd: string, env: Record<string, string> | undefined = undefined): Promise<{ stdout: string; stderr: string; result: Awaited<ReturnType<Process['wait']>> }> {
  const proc = new Process(command, args, env ? { cwd, env } : { cwd });
  proc.stdin.close();
  const [stdout, stderr, result] = await Promise.all([
    readAll(proc.stdout),
    readAll(proc.stderr),
    proc.wait(),
  ]);
  return { stdout, stderr, result };
}

describe('fino init', () => {
  let fs: DiskFileSystem;
  let appDir: string;

  before(async () => {
    fs = new DiskFileSystem();
    await fs.mkdir(TEST_DIR);
    appDir = TEST_DIR + '/app';
    await fs.mkdir(appDir);
  });

  after(async () => {
    await removeTree(fs, TEST_DIR);
  });

  it('creates package.json from flags in non-interactive mode', async (t) => {
    const run = await runCli([
      'init',
      '--name', 'demo-app',
      '--description', 'Demo package',
      '--license', 'MIT',
      '--author', 'Fino Team',
      '--repository', 'https://example.com/repo.git',
    ], appDir);

    t.equal(run.result.code, 0, 'init exits successfully');
    t.equal(run.stderr, '', 'init writes no stderr');

    const pkg = JSON.parse(await fs.readFile(appDir + '/package.json')) as PackageJsonShape;
    t.equal(pkg.name, 'demo-app', 'writes package name');
    t.equal(pkg.version, '1.0.0', 'writes default version');
    t.equal(pkg.type, 'module', 'writes module type');
    t.equal(pkg.description, 'Demo package', 'writes description');
    t.equal(pkg.license, 'MIT', 'writes license');
    t.equal(pkg.author, 'Fino Team', 'writes author');
    t.equal(pkg.repository, 'https://example.com/repo.git', 'writes repository');
  });

  it('fills missing values from defaults in non-interactive mode', async (t) => {
    const secondDir = TEST_DIR + '/needs-prompt';
    const emptyHomeDir = TEST_DIR + '/empty-home';
    await fs.mkdir(secondDir);
    await fs.mkdir(emptyHomeDir);

    const run = await runCliWithEnv(['init'], secondDir, {
      HOME: emptyHomeDir,
      PATH: '/usr/bin:/bin:/usr/local/bin',
    });

    t.equal(run.result.code, 0, 'init succeeds with defaults');
    t.equal(run.stderr, '', 'no stderr for default init');

    const pkg = JSON.parse(await fs.readFile(secondDir + '/package.json')) as PackageJsonShape;
    t.equal(pkg.name, 'needs-prompt', 'defaults name from directory');
    t.equal(pkg.version, '1.0.0', 'defaults version');
    t.equal(pkg.description, '', 'defaults description to empty');
    t.equal(pkg.license, 'MIT', 'defaults license to MIT');
    t.equal(pkg.author, '', 'defaults author to empty when git config missing');
    t.equal(pkg.repository, '', 'defaults repository to empty when git config missing');
  });

  it('fills author and repository from git config defaults when available', async (t) => {
    const thirdDir = TEST_DIR + '/git-defaults';
    const homeDir = TEST_DIR + '/home';
    await fs.mkdir(thirdDir);
    await fs.mkdir(homeDir);
    await fs.writeFile(homeDir + '/.gitconfig', [
      '[user]',
      '  name = Jane Doe',
      '  email = jane@example.com',
      '',
    ].join('\n'));

    let git = await runCommand('/usr/bin/env', ['git', 'init'], thirdDir);
    t.equal(git.result.code, 0, 'git init succeeds');

    git = await runCommand('/usr/bin/env', ['git', 'remote', 'add', 'origin', 'https://example.com/fino/demo.git'], thirdDir);
    t.equal(git.result.code, 0, 'git remote add succeeds');

    const run = await runCliWithEnv(['init'], thirdDir, {
      HOME: homeDir,
      PATH: '/usr/bin:/bin:/usr/local/bin',
    });

    t.equal(run.result.code, 0, 'init succeeds with git defaults');
    const pkg = JSON.parse(await fs.readFile(thirdDir + '/package.json')) as PackageJsonShape;
    t.equal(pkg.author, 'Jane Doe <jane@example.com>', 'author pulled from git config');
    t.equal(pkg.repository, 'https://example.com/fino/demo.git', 'repository pulled from git remote');
  });
});
