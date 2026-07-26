/**
 * Process tests for fino:process info APIs and child process spawning.
 */
import { describe, it } from 'fino:test/test';
import {
  os,
  arch,
  argv,
  env,
  execPath,
  pid,
  ppid,
  cwd,
  chdir,
  kill,
  signal,
  SIGKILL,
  Process,
  processStats,
  processStatsSignal,
  processSandboxCapabilities,
} from 'fino:process';
import { DiskFileSystem } from 'fino:file';
import * as loop from 'internal:runtime/loop';
const encodeUtf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const decodeUtf8 = (b: ArrayBuffer | ArrayBufferView): string => new TextDecoder().decode(b);
const childEnv = Object.fromEntries(
  Object.entries(env).filter(([, v]) => v !== undefined),
) as Record<string, string>;
const fs = new DiskFileSystem();
async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  const timer = loop.timeout(ms);
  try {
    return await Promise.race([
      promise,
      timer.then(() => {
        throw new Error(`${label} timed out after ${ms}ms`);
      }),
    ]);
  } finally {
    timer.cancel();
  }
}
function joinChunks(chunks: Uint8Array[]): string {
  return decodeUtf8(
    chunks.reduce((acc: Uint8Array, c: Uint8Array) => {
      const merged = new Uint8Array(acc.byteLength + c.byteLength);
      merged.set(acc);
      merged.set(c, acc.byteLength);
      return merged;
    }, new Uint8Array(0)),
  );
}
describe('Platform info', () => {
  it('reports process stats and exposes a retained stats signal', async (t) => {
    const stats = processStats();
    t.equal(stats.pid, pid, 'stats use current pid');
    t.ok(stats.rssBytes > 0, 'rss is positive');
    t.ok(stats.timestamp > 0, 'timestamp is set');
    t.ok(stats.eventLoopLagMs >= 0, 'event loop lag is non-negative');
    const sig = processStatsSignal(5);
    const seen: number[] = [];
    const dispose = sig.subscribe((next) => seen.push(next.timestamp));
    await loop.timeout(20);
    dispose();
    t.ok(seen.length > 0, 'stats signal emits while subscribed');
    t.ok(sig.get().timestamp >= stats.timestamp, 'signal retains latest stats');
  });
  it('os is a non-empty string', (t) => {
    t.equal(typeof os, 'string');
    t.ok(os.length > 0, 'os is non-empty');
  });
  it('arch is a non-empty string', (t) => {
    t.equal(typeof arch, 'string');
    t.ok(arch.length > 0, 'arch is non-empty');
  });
  it('os is a known platform', (t) => {
    const known = ['darwin', 'linux', 'windows', 'freebsd', 'unknown'];
    t.ok(known.includes(os), 'os is known: ' + os);
  });
  it('arch is a known architecture', (t) => {
    const known = ['x86_64', 'aarch64', 'x86', 'arm', 'unknown'];
    t.ok(known.includes(arch), 'arch is known: ' + arch);
  });
  it('argv is an array with at least one entry', (t) => {
    t.ok(Array.isArray(argv), 'argv is an Array');
    t.ok(argv.length >= 1, 'argv has at least the binary name');
    t.equal(typeof argv[0], 'string', 'argv[0] is a string');
  });
  it('env is a plain object with string values', (t) => {
    t.ok(env !== null && typeof env === 'object', 'env is an object');
    const keys = Object.keys(env);
    t.ok(keys.length > 0, 'env has at least one entry');
    for (const k of keys) {
      t.equal(typeof env[k], 'string', `env[${k}] is a string`);
    }
  });
  it('execPath is a non-empty string', (t) => {
    t.equal(typeof execPath, 'string');
    t.ok(execPath.length > 0, 'execPath is non-empty');
  });
});
describe('Process APIs', () => {
  it('pid is a positive integer', (t) => {
    t.equal(typeof pid, 'number');
    t.ok(pid > 0, `pid ${pid} > 0`);
    t.ok(Number.isInteger(pid), 'pid is an integer');
  });
  it('ppid is a non-negative integer', (t) => {
    t.equal(typeof ppid, 'number');
    t.ok(ppid >= 0, `ppid ${ppid} >= 0`);
    t.ok(Number.isInteger(ppid), 'ppid is an integer');
  });
  it('cwd() returns a non-empty string', (t) => {
    const dir = cwd();
    t.equal(typeof dir, 'string');
    t.ok(dir.length > 0, 'cwd is non-empty');
    t.ok(dir.startsWith('/'), 'cwd is absolute');
  });
  it('chdir() changes and restores working directory', (t) => {
    const original = cwd();
    chdir('/tmp');
    t.ok(cwd().endsWith('tmp'), `cwd after chdir('/tmp') ends with tmp`);
    chdir(original);
    t.equal(cwd(), original);
  });
  it('internal:process cannot be imported from user code', async (t) => {
    const script = `/tmp/fino-internal-process-check-${pid}.ts`;
    await fs.writeFile(script, encodeUtf8("await import('internal:process');\n"));
    const proc = new Process(execPath, [script]);
    proc.stdin.close();
    const chunks: Uint8Array[] = [];
    try {
      for await (const chunk of proc.stderr) chunks.push(chunk);
      for await (const _ of proc.stdout) {
      }
      const { code } = await proc.wait();
      const errMsg = joinChunks(chunks);
      t.notEqual(code, 0, 'importing internal:process from user code exits non-zero');
      t.ok(
        errMsg.toLowerCase().includes('internal') &&
          (errMsg.includes('blocked') || errMsg.includes('cannot')),
        `error mentions internal module: ${errMsg}`,
      );
    } finally {
      try {
        await fs.unlink(script);
      } catch {}
    }
  });
});
describe('Process class', () => {
  it('reports sandbox backend capabilities without spawning', (t) => {
    const capabilities = processSandboxCapabilities();
    t.equal(capabilities.platform, os, 'capabilities use the current platform');
    const expectedStrict =
      os === 'linux' ||
      capabilities.features.some(
        (feature) => feature.name === 'macos-seatbelt' && feature.available,
      );
    t.equal(
      capabilities.strictAvailable,
      expectedStrict,
      'strict mode availability follows the probed mechanisms',
    );
    t.equal(capabilities.bestEffortAvailable, true, 'best-effort reporting is available');
    t.ok(
      capabilities.backends.some((backend) => backend.name === 'none' && backend.available),
      'reporting-only backend is listed',
    );
    t.ok(
      capabilities.backends.some((backend) => backend.name === 'linuxNative'),
      'Linux in-process backend is listed',
    );
    t.ok(
      capabilities.backends.some((backend) => backend.name === 'macosSeatbelt'),
      'macOS Seatbelt backend is listed',
    );
    // Features are probed directly (no native daemon): landlock/seccomp on Linux,
    // macos-seatbelt on macOS.
    const featureNames = capabilities.features.map((feature) => feature.name);
    if (os === 'linux') {
      t.ok(featureNames.includes('landlock'), 'landlock feature is probed');
      t.ok(featureNames.includes('seccomp'), 'seccomp feature is probed');
    } else if (os === 'darwin') {
      t.ok(featureNames.includes('macos-seatbelt'), 'macos-seatbelt feature is probed');
    }
    t.ok(
      capabilities.features.every(
        (feature) => typeof feature.reason === 'string' && feature.reason.length > 0,
      ),
      'features include reasons',
    );
  });
  it('reports no sandbox when no sandbox was requested', async (t) => {
    const proc = new Process('/bin/echo', ['plain']);
    t.equal(proc.sandboxReport.mode, 'none', 'mode is none');
    t.equal(proc.sandboxReport.backend, 'none', 'backend is none');
    t.equal(proc.sandboxReport.securityBoundary, false, 'plain process is not sandboxed');
    t.equal(proc.sandboxReport.supported.length, 0, 'no supported sandbox categories');
    t.equal(proc.sandboxReport.enforced.length, 0, 'no enforced categories');
    t.equal(proc.sandboxReport.unsupported.length, 0, 'no unsupported requested categories');
    t.equal(proc.sandboxReport.diagnostics.length, 0, 'no sandbox diagnostics');
    t.equal(proc.sandboxReport.violationBehavior.length, 0, 'no sandbox violation behavior');
    proc.stdin.close();
    for await (const _ of proc.stdout) {
    }
    for await (const _ of proc.stderr) {
    }
    const { code } = await proc.wait();
    t.equal(code, 0);
  });
  it('spawns strict sandboxed processes while preserving stdout when a strict backend is available', async (t) => {
    const capabilities = processSandboxCapabilities();
    if (!capabilities.strictAvailable) {
      t.throws(
        () =>
          new Process('/bin/echo', ['strict'], {
            sandbox: {
              mode: 'strict',
            },
          }),
        /strict sandbox mode is not available/,
        'strict sandbox requests fail closed without a backend',
      );
      return;
    }
    // Coarse network denial is enforceable on every strict backend (seccomp on
    // Linux, Seatbelt on macOS) without Landlock or cgroups.
    const proc = new Process('/bin/echo', ['strict'], {
      sandbox: {
        mode: 'strict',
        network: {
          outbound: [{ action: 'deny', destination: '*' }],
        },
      },
    });
    t.equal(proc.sandboxReport.mode, 'strict', 'strict mode is reported');
    t.equal(
      proc.sandboxReport.backend,
      os === 'linux' ? 'linuxNative' : 'macosSeatbelt',
      'native strict backend is selected',
    );
    t.equal(proc.sandboxReport.securityBoundary, true, 'strict backend is a security boundary');
    t.ok(
      proc.sandboxReport.enforced.some((entry) => entry.category === 'network'),
      'network policy is enforced',
    );
    proc.stdin.close();
    const chunks = [];
    for await (const chunk of proc.stdout) chunks.push(chunk);
    for await (const _ of proc.stderr) {
    }
    const { code } = await proc.wait();
    t.equal(code, 0, 'strict child exits successfully');
    t.equal(joinChunks(chunks).trim(), 'strict', 'strict child stdout remains readable');
  });
  it('rejects unsupported strict sandbox policy instead of spawning unsandboxed', (t) => {
    // Filtered egress (a rule with a concrete destination) is not enforceable on
    // any backend and must be rejected before spawn on every platform.
    t.throws(
      () =>
        new Process('/bin/echo', ['strict-network'], {
          sandbox: {
            mode: 'strict',
            network: {
              outbound: [{ action: 'allow', destination: 'example.com' }],
            },
          },
        }),
      /filtered egress/,
      'strict unsupported policy cannot silently downgrade',
    );
  });
  it('strict sandbox enforces a memory limit on Linux', async (t) => {
    if (os !== 'linux') return;
    // A rlimit fallback must constrain the payload, not the TypeScript/V8
    // launcher that prepares it. This deliberately sits below V8's reserved
    // address space so applying RLIMIT_AS too early kills the launcher.
    const memoryBytes = 8 * 1024 * 1024 * 1024;
    const previousCgroupRoot = env.FINO_SANDBOX_CGROUP_ROOT;
    env.FINO_SANDBOX_CGROUP_ROOT = '/fino-test-no-delegated-cgroup';
    const proc = (() => {
      try {
        return new Process('/bin/sh', ['-c', 'ulimit -v'], {
          sandbox: {
            mode: 'strict',
            resources: {
              memoryBytes,
            },
          },
        });
      } finally {
        if (previousCgroupRoot === undefined) delete env.FINO_SANDBOX_CGROUP_ROOT;
        else env.FINO_SANDBOX_CGROUP_ROOT = previousCgroupRoot;
      }
    })();
    const resources = proc.sandboxReport.enforced.find((entry) => entry.category === 'resources');
    const resourcesDiagnostic = proc.sandboxReport.diagnostics.find((entry) =>
      entry.startsWith('resources:'),
    );
    t.ok(resources !== undefined, 'resources policy is reported enforced');
    proc.stdin.close();
    const readChunks = async (reader: typeof proc.stdout): Promise<Uint8Array[]> => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of reader) chunks.push(chunk);
      return chunks;
    };
    const [chunks, stderrChunks, { code, signal }] = await Promise.all([
      readChunks(proc.stdout),
      readChunks(proc.stderr),
      proc.wait(),
    ]);
    const stderrText = joinChunks(stderrChunks).trim();
    t.equal(
      signal,
      null,
      `strict resource child is not killed by a signal${stderrText ? `: ${stderrText}` : ''}`,
    );
    t.equal(
      code,
      0,
      `strict resource child exits successfully${stderrText ? `: ${stderrText}` : ''}`,
    );
    // The mechanism depends on the host: an RLIMIT_AS fallback shows up in
    // `ulimit -v` (KiB); a cgroup memory.max does not (ulimit stays unlimited).
    const ulimitKib = Number(joinChunks(chunks).trim());
    if (resourcesDiagnostic?.includes('[tier: rlimit]')) {
      t.equal(
        ulimitKib,
        memoryBytes / 1024,
        'rlimit-tier child sees the configured address-space limit in KiB',
      );
    } else {
      t.ok(
        resourcesDiagnostic?.includes('[tier: cgroup]'),
        'resources diagnostic identifies the cgroup enforcement tier',
      );
      t.ok(
        /cgroup/i.test(resources!.reason),
        'cgroup-tier memory limit is enforced via memory.max',
      );
    }
  });
  it('strict sandbox filesystem policy denies unlisted paths on Linux', async (t) => {
    if (os !== 'linux') return;
    const capabilities = processSandboxCapabilities();
    if (!capabilities.strictAvailable) return;
    const hasLandlock = capabilities.backends.some(
      (b) => b.name === 'linuxNative' && b.supported.includes('filesystem'),
    );
    if (!hasLandlock) {
      t.throws(
        () =>
          new Process('/bin/cat', ['/tmp/no-such-file'], {
            sandbox: {
              mode: 'strict',
              filesystem: {
                readonly: ['/tmp'],
              },
            },
          }),
        /Landlock/,
        'filesystem strict policy fails closed without Landlock',
      );
      return;
    }
    const suffix = `${pid}-${Date.now()}`;
    const allowedDir = `/tmp/fino-strict-fs-allowed-${suffix}`;
    const deniedDir = `/tmp/fino-strict-fs-denied-${suffix}`;
    const allowedFile = `${allowedDir}/allowed.txt`;
    const deniedFile = `${deniedDir}/denied.txt`;
    await fs.mkdir(allowedDir);
    await fs.mkdir(deniedDir);
    await fs.writeFile(allowedFile, encodeUtf8('allowed\n'));
    await fs.writeFile(deniedFile, encodeUtf8('denied\n'));
    try {
      const proc = new Process('/bin/cat', [allowedFile, deniedFile], {
        sandbox: {
          mode: 'strict',
          filesystem: {
            readonly: ['/bin', '/usr', '/lib', '/lib64', '/etc', allowedDir],
          },
          process: {
            allowedBinaries: ['/bin/cat'],
          },
        },
      });
      t.ok(
        proc.sandboxReport.enforced.some((entry) => entry.category === 'filesystem'),
        'filesystem policy is reported enforced',
      );
      proc.stdin.close();
      const stdoutChunks = [];
      const stderrChunks = [];
      for await (const chunk of proc.stdout) stdoutChunks.push(chunk);
      for await (const chunk of proc.stderr) stderrChunks.push(chunk);
      const { code } = await proc.wait();
      t.notEqual(code, 0, 'cat exits non-zero after denied read');
      t.equal(joinChunks(stdoutChunks), 'allowed\n', 'allowed file remains readable');
      t.ok(joinChunks(stderrChunks).length > 0, 'denied file produces stderr');
    } finally {
      try {
        await fs.unlink(allowedFile);
      } catch {}
      try {
        await fs.unlink(deniedFile);
      } catch {}
      try {
        await fs.rmdir(allowedDir);
      } catch {}
      try {
        await fs.rmdir(deniedDir);
      } catch {}
    }
  });
  it('strict sandbox process policy denies disallowed initial binaries on Linux', (t) => {
    if (os !== 'linux') return;
    t.throws(
      () =>
        new Process('/bin/echo', ['denied'], {
          sandbox: {
            mode: 'strict',
            process: {
              allowedBinaries: ['/bin/cat'],
            },
          },
          // With Landlock, the pre-spawn allowlist check names the binary; without
          // it, allowedBinaries fails closed for lack of Landlock. Either way the
          // spawn is denied.
        }),
      /not listed in process\.allowedBinaries|Landlock/,
      'disallowed command is denied before spawn',
    );
  });
  it('strict sandbox process policy denies fork on Linux', async (t) => {
    if (os !== 'linux') return;
    const proc = new Process('/bin/sh', ['-c', '(:) & wait'], {
      sandbox: {
        mode: 'strict',
        process: {
          allowFork: false,
        },
      },
    });
    proc.stdin.close();
    for await (const _ of proc.stdout) {
    }
    for await (const _ of proc.stderr) {
    }
    const { code } = await proc.wait();
    t.notEqual(code, 0, 'fork attempt fails under strict no-fork policy');
  });
  it('spawns with best-effort sandbox mode and reports unenforced policy categories', async (t) => {
    const proc = new Process('/bin/echo', ['best-effort'], {
      sandbox: {
        mode: 'bestEffort',
        resources: {
          memoryBytes: 16 * 1024 * 1024,
        },
        filesystem: {
          writable: ['/tmp'],
        },
        network: {
          outbound: [
            {
              action: 'deny',
              destination: '*',
            },
          ],
        },
      },
    });
    t.equal(proc.sandboxReport.mode, 'bestEffort', 'report records selected mode');
    t.equal(proc.sandboxReport.backend, 'none', 'no enforcing sandbox backend is active');
    t.equal(proc.sandboxReport.securityBoundary, false, 'best-effort is not a security boundary');
    t.equal(
      proc.sandboxReport.supported.length,
      0,
      'no categories are supported by the reporting-only backend',
    );
    t.ok(
      proc.sandboxReport.unsupported.some((entry) => entry.category === 'filesystem'),
      'filesystem policy is reported unsupported',
    );
    t.ok(
      proc.sandboxReport.unsupported.some((entry) => entry.category === 'network'),
      'network policy is reported unsupported',
    );
    t.ok(
      proc.sandboxReport.unsupported.some((entry) => entry.category === 'resources'),
      'resource policy is reported unsupported',
    );
    t.ok(
      proc.sandboxReport.diagnostics.some((entry) => entry.includes('posix_spawnp')),
      'diagnostics explain reporting-only spawn',
    );
    t.equal(
      proc.sandboxReport.violationBehavior.length,
      0,
      'no violation behavior is claimed without enforcement',
    );
    const chunks = [];
    for await (const chunk of proc.stdout) chunks.push(chunk);
    for await (const _ of proc.stderr) {
    }
    const { code } = await proc.wait();
    t.equal(code, 0);
    t.equal(joinChunks(chunks).trim(), 'best-effort');
  });
  it('validates sandbox resource limits before spawning', (t) => {
    t.throws(
      () =>
        new Process('/bin/echo', ['bad-memory'], {
          sandbox: {
            mode: 'bestEffort',
            resources: {
              memoryBytes: 0,
            },
          },
        }),
      /sandbox\.resources\.memoryBytes/,
      'memory limit must be positive',
    );
    t.throws(
      () =>
        new Process('/bin/echo', ['bad-cpu'], {
          sandbox: {
            mode: 'bestEffort',
            resources: {
              cpu: Number.POSITIVE_INFINITY,
            },
          },
        }),
      /sandbox\.resources\.cpu/,
      'cpu limit must be finite',
    );
  });
  it('validates sandbox filesystem paths before spawning', (t) => {
    t.throws(
      () =>
        new Process('/bin/echo', ['bad-path'], {
          sandbox: {
            mode: 'bestEffort',
            filesystem: {
              writable: ['relative/path'],
            },
          },
        }),
      /sandbox\.filesystem\.writable\[0\]/,
      'filesystem paths must be absolute',
    );
    t.throws(
      () =>
        new Process('/bin/echo', ['nul-path'], {
          sandbox: {
            mode: 'bestEffort',
            filesystem: {
              readonly: ['/tmp/\0bad'],
            },
          },
        }),
      /sandbox\.filesystem\.readonly\[0\]/,
      'filesystem paths cannot contain null bytes',
    );
  });
  it('validates sandbox network rules before spawning', (t) => {
    t.throws(
      () =>
        new Process('/bin/echo', ['bad-action'], {
          sandbox: {
            mode: 'bestEffort',
            network: {
              outbound: [
                {
                  action: 'drop' as any,
                  destination: '*',
                },
              ],
            },
          },
        }),
      /sandbox\.network\.outbound\[0\]\.action/,
      'network action must be allow or deny',
    );
    t.throws(
      () =>
        new Process('/bin/echo', ['bad-port'], {
          sandbox: {
            mode: 'bestEffort',
            network: {
              inbound: [
                {
                  action: 'allow',
                  port: 70000,
                },
              ],
            },
          },
        }),
      /sandbox\.network\.inbound\[0\]\.port/,
      'network port must be valid',
    );
  });
  it('validates sandbox process and syscall policies before spawning', (t) => {
    t.throws(
      () =>
        new Process('/bin/echo', ['bad-binaries'], {
          sandbox: {
            mode: 'bestEffort',
            process: {
              allowedBinaries: ['node', ''],
            },
          },
        }),
      /sandbox\.process\.allowedBinaries\[1\]/,
      'allowed binaries must be non-empty',
    );
    t.throws(
      () =>
        new Process('/bin/echo', ['bad-syscalls'], {
          sandbox: {
            mode: 'bestEffort',
            syscalls: {
              mode: 'maybe' as any,
              names: ['open'],
            },
          },
        }),
      /sandbox\.syscalls\.mode/,
      'syscall mode must be allowlist or denylist',
    );
  });
  it('spawns /bin/echo and reads stdout', async (t) => {
    const proc = new Process('/bin/echo', ['hello fino']);
    const chunks = [];
    for await (const chunk of proc.stdout) chunks.push(chunk);
    t.equal(joinChunks(chunks).trim(), 'hello fino');
    const { code } = await proc.wait();
    t.equal(code, 0);
  });
  it('wait() returns correct exit code', async (t) => {
    const proc = new Process('/bin/sh', ['-c', 'exit 42']);
    proc.stdin.close();
    for await (const _ of proc.stdout) {
    }
    for await (const _ of proc.stderr) {
    }
    const { code, signal } = await proc.wait();
    t.equal(code, 42);
    t.equal(signal, null);
  });
  it('stdin pipes to child stdin', async (t) => {
    const proc = new Process('/bin/cat', []);
    await proc.stdin.write(encodeUtf8('ping\n'));
    proc.stdin.close();
    const chunks = [];
    for await (const chunk of proc.stdout) chunks.push(chunk);
    t.equal(joinChunks(chunks), 'ping\n');
    await proc.wait();
  });
  it('captures stderr', async (t) => {
    const proc = new Process('/bin/sh', ['-c', 'echo err >&2']);
    proc.stdin.close();
    for await (const _ of proc.stdout) {
    }
    const errChunks = [];
    for await (const chunk of proc.stderr) errChunks.push(chunk);
    t.equal(joinChunks(errChunks).trim(), 'err');
    await proc.wait();
  });
  it('drains high-volume stdout and stderr concurrently', async (t) => {
    const proc = new Process(
      execPath,
      [new URL('../fixtures/process-high-volume-output.ts', import.meta.url).pathname],
      { env: childEnv },
    );
    proc.stdin.close();
    const [stdoutChunks, stderrChunks, result] = await Promise.all([
      (async () => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of proc.stdout) chunks.push(chunk);
        return chunks;
      })(),
      (async () => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of proc.stderr) chunks.push(chunk);
        return chunks;
      })(),
      proc.wait(),
    ]);
    const stdoutText = joinChunks(stdoutChunks);
    const stderrText = joinChunks(stderrChunks);
    t.equal(result.code, 0, 'child exits successfully');
    t.equal(result.signal, null, 'child exits without signal');
    t.ok(stdoutText.length > 160 * 1024, 'stdout payload exceeds a typical pipe buffer');
    t.ok(stderrText.length > 160 * 1024, 'stderr payload exceeds a typical pipe buffer');
    t.ok(stdoutText.includes('stdout:0:'), 'stdout starts with first marker');
    t.ok(stdoutText.includes('stdout:159:'), 'stdout includes final marker');
    t.ok(stderrText.includes('stderr:0:'), 'stderr starts with first marker');
    t.ok(stderrText.includes('stderr:159:'), 'stderr includes final marker');
  });
  it('cwd option changes child working directory', async (t) => {
    const proc = new Process('/bin/pwd', [], { cwd: '/tmp' });
    proc.stdin.close();
    const chunks = [];
    for await (const chunk of proc.stdout) chunks.push(chunk);
    t.ok(joinChunks(chunks).trim().endsWith('tmp'), 'pwd output ends with tmp');
    await proc.wait();
  });
  it('env option replaces the child environment', async (t) => {
    const proc = new Process('/usr/bin/env', [], { env: { FINO_PROCESS_TEST_ENV: 'present' } });
    proc.stdin.close();
    const chunks = [];
    for await (const chunk of proc.stdout) chunks.push(chunk);
    for await (const _ of proc.stderr) {
    }
    const { code } = await proc.wait();
    const output = joinChunks(chunks);
    t.equal(code, 0, 'env exits successfully');
    t.ok(output.includes('FINO_PROCESS_TEST_ENV=present'), 'custom env value is present');
    t.notOk(output.includes('PATH='), 'ambient PATH is not inherited when env is replaced');
  });
  it('does not implement Node-style shell or stdio option semantics', async (t) => {
    t.throws(
      () => new Process('echo fino-process-shell-option', [], { shell: true } as any),
      /posix_spawnp/,
      'shell option is not interpreted by Process',
    );
    const proc = new Process('/bin/echo', ['stdio-remains-piped'], { stdio: 'ignore' } as any);
    proc.stdin.close();
    const chunks = [];
    for await (const chunk of proc.stdout) chunks.push(chunk);
    for await (const _ of proc.stderr) {
    }
    const { code } = await proc.wait();
    t.equal(code, 0, 'child exits successfully');
    t.equal(
      joinChunks(chunks).trim(),
      'stdio-remains-piped',
      'stdout remains piped despite unsupported stdio option',
    );
  });
  it('failed spawn closes setup resources and does not break later spawns', async (t) => {
    t.throws(
      () => new Process('/definitely/not/a/fino-command', []),
      /posix_spawnp/,
      'missing command throws from constructor',
    );
    const proc = new Process('/bin/echo', ['after-failed-spawn']);
    proc.stdin.close();
    const chunks = [];
    for await (const chunk of proc.stdout) chunks.push(chunk);
    for await (const _ of proc.stderr) {
    }
    const { code } = await proc.wait();
    t.equal(code, 0, 'subsequent spawn still succeeds');
    t.equal(joinChunks(chunks).trim(), 'after-failed-spawn', 'subsequent stdout is readable');
  });
  it('kill() sends signal to child', async (t) => {
    const proc = new Process('/bin/sleep', ['60']);
    proc.kill();
    const { code, signal } = await proc.wait();
    t.equal(code, null);
    t.ok(signal !== null, 'child was signalled');
  });
  it('spawned children do not inherit runtime signal handling', async (t) => {
    const topic = signal('SIGTERM');
    const handle = topic.subscribe(() => {});
    handle.dispose();
    const proc = new Process('/bin/sleep', ['60']);
    const waiting = proc.wait();
    proc.kill();
    let result: Awaited<ReturnType<Process['wait']>>;
    try {
      result = await withTimeout(waiting, 1e3, 'child SIGTERM wait');
    } catch (err) {
      try {
        proc.kill(SIGKILL);
      } catch {}
      await waiting.catch(() => {});
      throw err;
    }
    t.equal(result.code, null);
    t.ok(result.signal !== null, 'child used default signal disposition');
  });
  it('wait() rejects when called more than once', async (t) => {
    const proc = new Process('/bin/sh', ['-c', 'true']);
    proc.stdin.close();
    for await (const _ of proc.stdout) {
    }
    for await (const _ of proc.stderr) {
    }
    const first = await proc.wait();
    t.equal(first.code, 0, 'first wait succeeds');
    await t.rejects(
      () => proc.wait(),
      /already been waited/,
      'second wait rejects with explicit guard',
    );
  });
  it('kill() throws after the process has been reaped', async (t) => {
    const proc = new Process('/bin/sh', ['-c', 'true']);
    proc.stdin.close();
    for await (const _ of proc.stdout) {
    }
    for await (const _ of proc.stderr) {
    }
    await proc.wait();
    t.throws(() => proc.kill(), /kill\(/, 'failed kill is surfaced');
  });
});
describe('exit() propagates non-zero code to parent', () => {
  it('exit(42) results in wait().code === 42', async (t) => {
    const proc = new Process(
      execPath,
      [new URL('../fixtures/exit-with-code.ts', import.meta.url).pathname],
      { env: childEnv },
    );
    proc.stdin.close();
    for await (const _ of proc.stdout) {
    }
    const { code, signal } = await proc.wait();
    t.equal(code, 42, 'exit(42) produces wait().code === 42');
    t.equal(signal, null, 'process exited normally (no signal)');
  });
});
describe('B1 regression: exit() flushes stdout before terminating', () => {
  it('output written to stdout before exit(0) is captured by the parent', async (t) => {
    // Spawn a child process that writes to stdout then calls exit(0).
    // If exit() does not flush the coalesce buffer, the output is lost and
    // the test fails.
    const proc = new Process(
      execPath,
      [new URL('../fixtures/exit-with-output.ts', import.meta.url).pathname],
      { env: childEnv },
    );
    proc.stdin.close();
    const chunks: Uint8Array[] = [];
    for await (const chunk of proc.stdout) chunks.push(chunk);
    const { code } = await proc.wait();
    const captured = decodeUtf8(
      chunks.reduce((acc, c) => {
        const m = new Uint8Array(acc.byteLength + c.byteLength);
        m.set(acc);
        m.set(c, acc.byteLength);
        return m;
      }, new Uint8Array(0)),
    );
    t.equal(code, 0, 'child exited with code 0');
    t.ok(
      captured.includes('exit-flush-test-output'),
      'stdout was flushed before exit: ' + JSON.stringify(captured),
    );
  });
});
