import { DiskFileSystem } from 'fino:file';
import { env, Process } from 'fino:process';
import * as loop from 'internal:runtime/loop';
const fs = new DiskFileSystem();
const dec = new TextDecoder();
export async function exists(path: string): Promise<boolean> {
  try {
    await fs.lstat(path);
    return true;
  } catch {
    return false;
  }
}
export async function collect(
  reader: AsyncIterable<Uint8Array>,
  onChunk?: (text: string) => void,
): Promise<string> {
  let out = '';
  for await (const chunk of reader) {
    const text = dec.decode(chunk);
    out += text;
    onChunk?.(text);
  }
  return out;
}
export function delay(ms: number): Promise<void> {
  return loop.timeout(ms);
}
export async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    delay(ms).then(() => {
      throw new Error(`${label} timed out after ${ms}ms`);
    }),
  ]);
}
export function spawnNodeQuic(nodeBin: string, script: string, args: string[] = []): Process {
  const proc = new Process(nodeBin, [
    '--experimental-quic',
    '--experimental-stream-iter',
    '--no-warnings',
    script,
    ...args,
  ]);
  proc.stdin.close();
  return proc;
}
export async function supportsNodeQuic(nodeBin: string): Promise<boolean> {
  const proc = new Process(nodeBin, [
    '--experimental-quic',
    '--no-warnings',
    '--input-type=module',
    '-e',
    "await import('node:quic')",
  ]);
  proc.stdin.close();
  const err = collect(proc.stderr);
  const out = collect(proc.stdout);
  const status = await withTimeout(proc.wait(), 5e3, 'Node QUIC capability probe');
  await err;
  await out;
  return status.code === 0;
}
export function spawnFino(script: string, args: string[] = []): Process {
  const proc = new Process('./target/debug/fino', [script, ...args]);
  proc.stdin.close();
  return proc;
}
export async function cleanupProcess(proc: Process, waitPromise: Promise<unknown>): Promise<void> {
  proc.kill();
  try {
    await withTimeout(waitPromise, 1e3, 'process cleanup');
  } catch {}
}
export function parseReadyAddress(output: string): {
  port: number;
} | null {
  const match = /ready (\{[^\n]+\})/.exec(output);
  if (match === null) return null;
  return JSON.parse(match[1]);
}
export async function configuredNodeQuicAvailable(): Promise<string | null> {
  const nodeBin = env.NODE_QUIC_BIN;
  if (nodeBin === undefined || nodeBin.length === 0 || !(await exists(nodeBin))) return null;
  return (await supportsNodeQuic(nodeBin)) ? nodeBin : null;
}
