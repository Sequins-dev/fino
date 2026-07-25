/**
* macOS-only strict sandbox enforcement via Seatbelt: filesystem confinement,
* process-exec scoping, and pre-spawn rejection of the categories Seatbelt
* cannot express in this API (syscalls, fork denial).
*
* These run directly on the macOS host (no VM needed). Non-macOS hosts return
* early.
*/
import { describe, it } from 'fino:test/test';
import { os, pid, Process, processSandboxCapabilities } from 'fino:process';
import { DiskFileSystem } from 'fino:file';
const fs = new DiskFileSystem();
const textEncoder = new TextEncoder();
function joinChunks(chunks: Uint8Array[]): string {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder().decode(merged);
}
async function run(cmd: string, args: string[], sandbox: unknown): Promise<{
  code: number | null;
  out: string;
}> {
  const proc = new Process(cmd, args, { sandbox } as never);
  proc.stdin.close();
  const chunks: Uint8Array[] = [];
  for await (const c of proc.stdout) chunks.push(c);
  for await (const _ of proc.stderr) {}
  return {
    code: (await proc.wait()).code,
    out: joinChunks(chunks).trim()
  };
}
describe('macOS Seatbelt filesystem confinement', () => {
  it('confines reads and writes to the granted paths', async (t) => {
    if (os !== 'darwin') return;
    if (!processSandboxCapabilities().strictAvailable) return;
    // /private/tmp is the canonical form of /tmp; Seatbelt matches resolved paths.
    const base = `/private/tmp/fino-sb-${pid}-${cryptoRand()}`;
    const allowed = `${base}/allowed`;
    const denied = `${base}/denied`;
    await fs.mkdir(base);
    await fs.mkdir(allowed);
    await fs.mkdir(denied);
    await fs.writeFile(`${allowed}/f.txt`, textEncoder.encode('ALLOWED\n'));
    await fs.writeFile(`${denied}/f.txt`, textEncoder.encode('DENIED\n'));
    try {
      const readAllowed = await run('/bin/cat', [`${allowed}/f.txt`], {
        mode: 'strict',
        filesystem: { readonly: [allowed] },
        process: { allowedBinaries: ['/bin/cat'] }
      });
      t.equal(readAllowed.code, 0, 'read of a readonly-granted path succeeds');
      t.equal(readAllowed.out, 'ALLOWED', 'granted file content is returned');
      const readDenied = await run('/bin/cat', [`${denied}/f.txt`], {
        mode: 'strict',
        filesystem: { readonly: [allowed] },
        process: { allowedBinaries: ['/bin/cat'] }
      });
      t.notEqual(readDenied.code, 0, 'read of an ungranted path is denied');
      const writeOk = await run('/usr/bin/touch', [`${allowed}/w.txt`], {
        mode: 'strict',
        filesystem: { writable: [allowed] },
        process: { allowedBinaries: ['/usr/bin/touch'] }
      });
      t.equal(writeOk.code, 0, 'write to a writable-granted path succeeds');
      const writeDenied = await run('/usr/bin/touch', [`${allowed}/nope.txt`], {
        mode: 'strict',
        filesystem: { readonly: [allowed] },
        process: { allowedBinaries: ['/usr/bin/touch'] }
      });
      t.notEqual(writeDenied.code, 0, 'write to a readonly-granted path is denied');
    } finally {
      const rm = new Process('/bin/rm', ['-rf', base]);
      rm.stdin.close();
      for await (const _ of rm.stdout) {}
      for await (const _ of rm.stderr) {}
      await rm.wait();
    }
  });
});
describe('macOS Seatbelt process-exec scoping', () => {
  it('permits allowlisted execs and denies the rest', async (t) => {
    if (os !== 'darwin') return;
    if (!processSandboxCapabilities().strictAvailable) return;
    // /bin/sh re-execs /bin/bash on macOS, so both are allowlisted for the shell.
    const denied = await run('/bin/sh', ['-c', 'exec /bin/ls /'], {
      mode: 'strict',
      process: {
        allowExec: false,
        allowedBinaries: ['/bin/sh', '/bin/bash']
      }
    });
    t.notEqual(denied.code, 0, 'exec of a non-allowlisted binary is denied');
    const allowed = await run('/bin/sh', ['-c', 'exec /bin/ls / >/dev/null'], {
      mode: 'strict',
      process: { allowedBinaries: [
        '/bin/sh',
        '/bin/bash',
        '/bin/ls'
      ] }
    });
    t.equal(allowed.code, 0, 'exec of an allowlisted binary succeeds');
  });
  it('reports filesystem and process enforcement via Seatbelt', async (t) => {
    if (os !== 'darwin') return;
    if (!processSandboxCapabilities().strictAvailable) return;
    const proc = new Process('/usr/bin/true', [], { sandbox: {
      mode: 'strict',
      filesystem: { readonly: ['/usr'] },
      process: { allowedBinaries: ['/usr/bin/true'] }
    } });
    t.equal(proc.sandboxReport.backend, 'macosSeatbelt', 'macOS uses the Seatbelt backend');
    t.equal(proc.sandboxReport.securityBoundary, true, 'strict Seatbelt spawn is a security boundary');
    t.ok(proc.sandboxReport.enforced.some((e) => e.category === 'filesystem'), 'filesystem is enforced');
    t.ok(proc.sandboxReport.enforced.some((e) => e.category === 'process'), 'process policy is enforced');
    t.ok(proc.sandboxReport.enforced.every((e) => !/Landlock|seccomp|cgroup/.test(e.reason)), 'no Linux mechanism wording');
    proc.stdin.close();
    for await (const _ of proc.stdout) {}
    for await (const _ of proc.stderr) {}
    await proc.wait();
  });
});
describe('macOS strict rejects Linux-only categories pre-spawn', () => {
  it('rejects syscalls and fork-denial policy', (t) => {
    if (os !== 'darwin') return;
    t.throws(() => new Process('/bin/echo', ['x'], { sandbox: {
      mode: 'strict',
      syscalls: {
        mode: 'denylist',
        names: ['ptrace']
      }
    } }), /seccomp/, 'syscall policy is rejected on macOS');
    t.throws(() => new Process('/bin/echo', ['x'], { sandbox: {
      mode: 'strict',
      process: { allowFork: false }
    } }), /seccomp/, 'fork denial is rejected on macOS');
  });
});
function cryptoRand(): string {
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  return [...b].map((n) => n.toString(16).padStart(2, '0')).join('');
}
