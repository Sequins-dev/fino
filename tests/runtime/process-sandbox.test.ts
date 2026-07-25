/**
* Tests for fino:process sandbox honesty: backend naming, pre-spawn rejection
* of policy that cannot be enforced, and platform-appropriate report wording.
*/
import { describe, it } from 'fino:test/test';
import { os, Process, processSandboxCapabilities } from 'fino:process';
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
describe('sandbox backend naming', () => {
  it('lists linuxNative and never the retired linuxSandboxd label', (t) => {
    const capabilities = processSandboxCapabilities();
    t.ok(capabilities.backends.some((backend) => backend.name === 'linuxNative'), 'linuxNative backend is listed');
    t.ok(capabilities.backends.every((backend) => !String(backend.name).includes('Sandboxd')), 'no daemon-implying backend names remain');
    t.ok(capabilities.backends.every((backend) => !backend.reason.includes('Sandboxd')), 'no daemon-implying backend reasons remain');
  });
  it('words backend availability reasons for the current platform', (t) => {
    const capabilities = processSandboxCapabilities();
    const linuxNative = capabilities.backends.find((backend) => backend.name === 'linuxNative');
    const seatbelt = capabilities.backends.find((backend) => backend.name === 'macosSeatbelt');
    t.ok(linuxNative !== undefined && seatbelt !== undefined, 'both platform backends are listed');
    if (os === 'linux') {
      t.equal(linuxNative!.available, true, 'linuxNative is available on Linux');
      t.equal(seatbelt!.available, false, 'Seatbelt is unavailable on Linux');
    } else if (os === 'darwin') {
      t.equal(linuxNative!.available, false, 'linuxNative is unavailable on macOS');
      t.ok(!linuxNative!.reason.includes('probed Linux enforcement features'), 'macOS does not claim live Linux enforcement');
    }
  });
});
describe('strict sandbox pre-spawn network rejection', () => {
  it('rejects outbound rules carrying destination detail before spawning', (t) => {
    t.throws(() => new Process('/bin/echo', ['x'], { sandbox: {
      mode: 'strict',
      network: { outbound: [{
        action: 'allow',
        destination: 'example.com'
      }] }
    } }), /filtered egress/, 'hostname destinations are rejected pre-spawn');
    t.throws(() => new Process('/bin/echo', ['x'], { sandbox: {
      mode: 'strict',
      network: { outbound: [{
        action: 'deny',
        destination: '10.0.0.0/8'
      }] }
    } }), /filtered egress/, 'CIDR destinations are rejected pre-spawn');
  });
  it('rejects rules carrying port or protocol detail before spawning', (t) => {
    t.throws(() => new Process('/bin/echo', ['x'], { sandbox: {
      mode: 'strict',
      network: { outbound: [{
        action: 'allow',
        destination: '*',
        port: 443
      }] }
    } }), /sandbox\.network\.outbound\[0\]\.port/, 'port detail is rejected pre-spawn');
    t.throws(() => new Process('/bin/echo', ['x'], { sandbox: {
      mode: 'strict',
      network: { inbound: [{
        action: 'deny',
        destination: '*',
        protocol: 'tcp'
      }] }
    } }), /sandbox\.network\.inbound\[0\]\.protocol/, 'protocol detail is rejected pre-spawn');
  });
  it('still accepts coarse allow/deny-all rules in strict mode', async (t) => {
    const capabilities = processSandboxCapabilities();
    const options = { sandbox: {
      mode: 'strict' as const,
      network: { outbound: [{
        action: 'deny' as const,
        destination: '*'
      }] }
    } };
    if (!capabilities.strictAvailable) {
      t.throws(() => new Process('/bin/echo', ['coarse'], options), /strict sandbox/, 'coarse rules still fail closed without a strict backend');
      return;
    }
    const proc = new Process('/bin/echo', ['coarse'], options);
    proc.stdin.close();
    for await (const _ of proc.stdout) {}
    for await (const _ of proc.stderr) {}
    const { code } = await proc.wait();
    t.equal(code, 0, 'coarse deny-all strict spawn still works');
  });
  it('leaves best-effort mode free to record fine-grained rules unenforced', async (t) => {
    const proc = new Process('/bin/echo', ['best-effort'], { sandbox: {
      mode: 'bestEffort',
      network: { outbound: [{
        action: 'allow',
        destination: 'example.com',
        port: 443,
        protocol: 'tcp'
      }] }
    } });
    t.equal(proc.sandboxReport.securityBoundary, false, 'best-effort is not a boundary');
    t.ok(proc.sandboxReport.unsupported.some((entry) => entry.category === 'network'), 'network policy is reported unenforced');
    proc.stdin.close();
    for await (const _ of proc.stdout) {}
    for await (const _ of proc.stderr) {}
    const { code } = await proc.wait();
    t.equal(code, 0);
  });
});
describe('strict sandbox launcher preserves the Process contract', () => {
  it('streams stdin to stdout under a strict sandbox', async (t) => {
    const capabilities = processSandboxCapabilities();
    if (!capabilities.strictAvailable) return;
    const proc = new Process('/bin/cat', [], { sandbox: { mode: 'strict' } });
    await proc.stdin.write(new TextEncoder().encode('round-trip\n'));
    proc.stdin.close();
    const chunks: Uint8Array[] = [];
    for await (const chunk of proc.stdout) chunks.push(chunk);
    for await (const _ of proc.stderr) {}
    const { code } = await proc.wait();
    t.equal(code, 0, 'strict cat exits cleanly');
    t.equal(joinChunks(chunks).trim(), 'round-trip', 'strict child round-trips stdin to stdout');
  });
  it('reports a strict security boundary and installed enforcement', async (t) => {
    const capabilities = processSandboxCapabilities();
    if (!capabilities.strictAvailable) return;
    // Coarse network denial is enforceable on every strict backend, so this
    // exercises the report without depending on Landlock or cgroups.
    const proc = new Process('/bin/echo', ['ok'], { sandbox: {
      mode: 'strict',
      network: { outbound: [{
        action: 'deny',
        destination: '*'
      }] }
    } });
    t.equal(proc.sandboxReport.mode, 'strict', 'report mode is strict');
    t.equal(proc.sandboxReport.backend, os === 'linux' ? 'linuxNative' : 'macosSeatbelt', 'backend matches platform');
    t.equal(proc.sandboxReport.securityBoundary, true, 'strict spawn is a security boundary');
    t.ok(proc.sandboxReport.enforced.some((entry) => entry.category === 'network'), 'network policy is enforced');
    // The report describes only mechanisms that could exist on this platform.
    const forbidden = os === 'linux' ? /Seatbelt/ : /Landlock|seccomp|cgroup/;
    t.ok(proc.sandboxReport.enforced.every((entry) => !forbidden.test(entry.reason)), 'no cross-platform mechanism wording');
    proc.stdin.close();
    for await (const _ of proc.stdout) {}
    for await (const _ of proc.stderr) {}
    await proc.wait();
  });
  it('kills a strict-sandboxed child', async (t) => {
    const capabilities = processSandboxCapabilities();
    if (!capabilities.strictAvailable) return;
    const proc = new Process('/bin/sh', ['-c', 'sleep 30'], { sandbox: { mode: 'strict' } });
    proc.kill();
    proc.stdin.close();
    for await (const _ of proc.stdout) {}
    for await (const _ of proc.stderr) {}
    const { code, signal } = await proc.wait();
    t.ok(code !== 0 || signal !== null, 'killed strict child does not exit zero');
  });
});
