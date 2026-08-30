/** Shared helpers for CLI command integration tests. */
import type { Assert } from 'fino:test/assert';
import { Process, env, execPath } from 'fino:process';
import { DiskFileSystem } from 'fino:file';
import * as loop from 'internal:runtime/loop';
import rootCommand from 'internal:commands/root';
export const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView): string => new TextDecoder().decode(b);

interface ProtobufField {
  number: number;
  value: number | Uint8Array;
}

function readVarint(bytes: Uint8Array, offset: { value: number }): number {
  let value = 0;
  let shift = 0;
  while (offset.value < bytes.byteLength) {
    const byte = bytes[offset.value++];
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7;
  }
  throw new Error('truncated protobuf varint');
}

function protobufFields(bytes: Uint8Array): ProtobufField[] {
  const fields: ProtobufField[] = [];
  const offset = { value: 0 };
  while (offset.value < bytes.byteLength) {
    const tag = readVarint(bytes, offset);
    const number = Math.floor(tag / 8);
    const wireType = tag & 7;
    if (wireType === 0) {
      fields.push({ number, value: readVarint(bytes, offset) });
      continue;
    }
    if (wireType === 2) {
      const length = readVarint(bytes, offset);
      const end = offset.value + length;
      if (end > bytes.byteLength) throw new Error('truncated protobuf field');
      fields.push({ number, value: bytes.slice(offset.value, end) });
      offset.value = end;
      continue;
    }
    throw new Error(`unsupported protobuf wire type ${wireType}`);
  }
  return fields;
}

export function pprofThreadLabels(bytes: Uint8Array): string[] {
  const fields = protobufFields(bytes);
  const strings = fields
    .filter((field) => field.number === 6)
    .map((field) => decodeUtf8(field.value as Uint8Array));
  const labels: string[] = [];
  for (const sample of fields.filter((field) => field.number === 2)) {
    for (const label of protobufFields(sample.value as Uint8Array).filter(
      (field) => field.number === 3,
    )) {
      const labelFields = protobufFields(label.value as Uint8Array);
      const key = labelFields.find((field) => field.number === 1)?.value;
      const value = labelFields.find((field) => field.number === 2)?.value;
      if (typeof key === 'number' && strings[key] === 'thread' && typeof value === 'number') {
        labels.push(strings[value]);
      }
    }
  }
  return labels;
}
async function readAll(reader: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of reader) chunks.push(chunk);
  return decodeUtf8(
    chunks.reduce((acc: Uint8Array, c: Uint8Array) => {
      const merged = new Uint8Array(acc.byteLength + c.byteLength);
      merged.set(acc);
      merged.set(c, acc.byteLength);
      return merged;
    }, new Uint8Array(0)),
  );
}
export async function runCli(
  args: string[],
  options: {
    env?: Record<string, string | undefined>;
    cwd?: string;
  } = {},
): Promise<{
  stdout: string;
  stderr: string;
  result: Awaited<ReturnType<Process['wait']>>;
}> {
  const childEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    ...env,
    ...(options.env || {}),
  })) {
    if (value !== undefined) childEnv[key] = value;
  }
  childEnv.FINO_OTEL_EXPORT_INTERVAL_MS ??= '20';
  const proc = new Process(execPath, args, {
    env: childEnv,
    cwd: options.cwd,
  });
  proc.stdin.close();
  const [stdout, stderr, result] = await Promise.all([
    readAll(proc.stdout),
    readAll(proc.stderr),
    proc.wait(),
  ]);
  return {
    stdout,
    stderr,
    result,
  };
}
async function mkdirp(fs: DiskFileSystem, path: string): Promise<void> {
  const parts = path.split('/').filter(Boolean);
  let current = path.startsWith('/') ? '' : '.';
  for (const part of parts) {
    current = current === '' ? '/' + part : current + '/' + part;
    try {
      await fs.mkdir(current);
    } catch {}
  }
}
async function rmrf(fs: DiskFileSystem, path: string): Promise<void> {
  const stat = await fs.lstat(path);
  if (stat.isDirectory()) {
    const dir = await fs.dir(path);
    for await (const entry of dir) await rmrf(fs, entry.path.toString());
    await fs.rmdir(path);
  } else {
    await fs.unlink(path);
  }
}
export async function withTempProject<T>(
  tree: Record<string, string>,
  fn: (dir: string, fs: DiskFileSystem) => Promise<T>,
): Promise<T> {
  const fs = new DiskFileSystem();
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const rawReadFile = fs.readFile.bind(fs);
  const rawWriteFile = fs.writeFile.bind(fs);
  fs.readFile = (async (path: string) => textDecoder.decode(await rawReadFile(path))) as never;
  fs.writeFile = (async (
    path: string,
    data: string | Uint8Array | ArrayBuffer | ArrayBufferView,
  ) => {
    await rawWriteFile(path, typeof data === 'string' ? textEncoder.encode(data) : data);
  }) as never;
  const dir = '/tmp/fino-tooling-cli-' + Math.floor(Math.random() * 1e9);
  await fs.mkdir(dir);
  try {
    for (const [rel, content] of Object.entries(tree)) {
      const path = dir + '/' + rel;
      const slash = path.lastIndexOf('/');
      if (slash > dir.length) await mkdirp(fs, path.slice(0, slash));
      await fs.writeFile(path, content as never);
    }
    return await fn(dir, fs);
  } finally {
    await rmrf(fs, dir);
  }
}
export async function poll(
  check: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`poll timed out after ${timeoutMs}ms`);
    await loop.timeout(50);
  }
}
export async function expectLiveOtelSignal(
  t: Assert,
  fixture: string,
  path: string,
  label: string,
): Promise<void> {
  const { stdout, stderr, result } = await runCli([
    '--otlp-endpoint',
    'http://collector.example:4318/custom',
    fixture,
  ]);
  t.equal(result.code, 0, `${label} script exits successfully`);
  t.equal(stderr, '', `${label} OTEL bootstrap does not write stderr`);
  const exportIndex = stdout.indexOf(`export:http://collector.example:4318/custom/v1/${path}`);
  const runningIndex = stdout.indexOf('still-running');
  t.ok(exportIndex !== -1, `${label} export happened during process lifetime`);
  t.ok(runningIndex !== -1, `${label} fixture remained alive after producing telemetry`);
  t.ok(exportIndex < runningIndex, `${label} export happened before the script finished running`);
}
export async function parseRoot(args: string[]): Promise<string> {
  const result = await rootCommand.parse(args);
  return typeof result === 'string' ? result : '';
}
export async function runRootInProcess(
  args: string[],
  options: {
    cwd?: string;
  } = {},
): Promise<{
  stdout: string;
  stderr: string;
  result: {
    code: number;
    signal: number | null;
  };
}> {
  try {
    const result = await rootCommand.parse(
      args,
      options.cwd === undefined ? {} : { cwd: options.cwd },
    );
    return {
      stdout: typeof result === 'string' ? result : '',
      stderr: '',
      result: {
        code: 0,
        signal: null,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      stdout: '',
      stderr: message + '\n',
      result: {
        code: 1,
        signal: null,
      },
    };
  }
}
