/** Optional external compiler checks with explicit CI opt-in gates. */
import { DiskFileSystem } from 'fino:file';
import { Process, env, os } from 'fino:process';
const fs = new DiskFileSystem();
export async function run(command: string, args: string[]) {
  const p = new Process(command, args);
  p.stdin.close();
  const drain = async (stream: AsyncIterable<Uint8Array>) => {
    const decoder = new TextDecoder();
    let output = '';
    for await (const bytes of stream) output += decoder.decode(bytes, { stream: true });
    return output + decoder.decode();
  };
  const [out, err, status] = await Promise.all([drain(p.stdout), drain(p.stderr), p.wait()]);
  return { code: status.code, output: out + err };
}
export async function findValidator() {
  for (const path of [
    '/opt/homebrew/bin/spirv-val',
    '/usr/local/bin/spirv-val',
    '/usr/bin/spirv-val',
  ]) {
    try {
      await fs.stat(path);
      return path;
    } catch {}
  }
  return null;
}
export async function withFile<T>(
  extension: string,
  data: Uint8Array,
  fn: (path: string) => Promise<T>,
) {
  const path = `/tmp/fino-kernel-${crypto.randomUUID()}.${extension}`;
  try {
    await fs.writeFile(path, data);
    return await fn(path);
  } finally {
    await fs.unlink(path);
  }
}
export { env, os };
