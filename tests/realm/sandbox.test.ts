/**
 * Tests for Linux sandbox Realms.
 *
 * A sandbox Realm owns a dedicated OS thread so thread-scoped Landlock,
 * seccomp, and cgroup v2 controls never affect the ordinary Realm workload
 * queue. It remains an in-process isolation mechanism, not a hostile-code
 * security boundary.
 */
import { describe, it } from 'fino:test/test';
import { dlopen } from 'fino:ffi';
import { os, processSandboxCapabilities } from 'fino:process';
import { Realm } from 'fino:realm';
import { port as parentRealmPort } from 'fino:realm/self';
import type echo from './fixtures/echo-fn.ts';
import type linuxCpuId from './fixtures/linux-cpu-id-fn.ts';
import type linuxThreadId from './fixtures/linux-thread-id-fn.ts';
import type sandboxAsyncFfi from './fixtures/sandbox-async-ffi-fn.ts';
import type sandboxBusyLoop from './fixtures/sandbox-busy-loop-fn.ts';
import type sandboxSyncGetpid from './fixtures/sandbox-sync-getpid-fn.ts';
import type sandboxOpen from './fixtures/sandbox-open-fn.ts';

const entry = new URL('./fixtures/hello.ts', import.meta.url).pathname;

describe('Sandbox Realm configuration', () => {
  it('is mutually exclusive with process and remote execution', (t) => {
    t.throws(
      () =>
        new Realm({
          entry,
          process: true,
          sandbox: { mode: 'strict' },
        } as any),
      /sandbox.*process|execution.*mutually exclusive/i,
      'sandbox and process cannot both own execution',
    );
    t.throws(
      () =>
        new Realm({
          entry,
          remote: true,
          sandbox: { mode: 'strict' },
        } as any),
      /sandbox.*remote|execution.*mutually exclusive/i,
      'sandbox and remote cannot both own execution',
    );
  });

  it('requires strict mode', (t) => {
    t.throws(
      () =>
        new Realm({
          entry,
          sandbox: { mode: 'bestEffort' },
        } as any),
      /sandbox.*strict/i,
      'best-effort policy cannot select the sandbox execution kind',
    );
  });

  it('rejects controls that cannot be isolated to one thread', (t) => {
    t.throws(
      () =>
        new Realm({
          entry,
          sandbox: {
            mode: 'strict',
            resources: { memoryBytes: 64 * 1024 * 1024 },
          },
        } as any),
      /memoryBytes.*process-wide|memory.*thread/i,
      'memory limits are not falsely claimed as thread-local',
    );
    t.throws(
      () =>
        new Realm({
          entry,
          sandbox: {
            mode: 'strict',
            process: { allowExec: true },
          },
        } as any),
      /allowExec.*false|exec.*host process/i,
      'a sandbox thread cannot replace the host process',
    );
    t.throws(
      () =>
        new Realm({
          entry,
          sandbox: {
            mode: 'strict',
            process: { allowFork: true },
          },
        } as any),
      /allowFork.*false|fork.*host process/i,
      'a sandbox thread cannot fork the host process',
    );
    t.throws(
      () =>
        new Realm({
          entry,
          sandbox: {
            mode: 'strict',
            resources: { cpus: '0--1' },
          },
        } as any),
      /resources\.cpus.*CPU list|cpus.*format/i,
      'malformed CPU affinity is rejected before the sandbox thread starts',
    );
  });

  it('rejects lifecycle modes that would outlive a fixed policy install', (t) => {
    t.throws(
      () =>
        new Realm({
          entry,
          watch: true,
          sandbox: { mode: 'strict' },
        } as any),
      /watch.*sandbox|sandbox.*watch/i,
      'watch reload is not silently moved to a new ungoverned thread',
    );
    t.throws(
      () =>
        new Realm({
          entry,
          repl: true,
          sandbox: { mode: 'strict' },
        } as any),
      /repl.*sandbox|sandbox.*repl/i,
      'REPL mode is not exposed through the sandbox realm path',
    );
    t.throws(
      () =>
        new Realm({
          entry,
          otlpEndpoint: 'http://127.0.0.1:4318',
          sandbox: { mode: 'strict' },
        } as any),
      /otlpEndpoint.*sandbox|sandbox.*OpenTelemetry/i,
      'telemetry work is not sent through process-global background facilities',
    );
  });

  it('is Linux-only', (t) => {
    if (os === 'linux') return;
    t.throws(
      () =>
        new Realm({
          entry,
          sandbox: { mode: 'strict' },
        } as any),
      /sandbox.*Linux|Linux.*sandbox/i,
      'non-Linux runtimes reject the specialized execution kind',
    );
  });
});

describe('Sandbox Realm placement', () => {
  it('runs on a dedicated Linux thread', async (t) => {
    if (os !== 'linux') return;
    const libc = dlopen('libc.so.6', {
      gettid: {
        parameters: [],
        result: 'i32',
      },
    });
    const parentTid = Number(libc.symbols.gettid());
    using realm = new Realm<typeof linuxThreadId>({
      entry: new URL('./fixtures/linux-thread-id-fn.ts', import.meta.url).pathname,
      sandbox: { mode: 'strict' },
    } as any);
    const childTid = await realm.call();
    t.notEqual(childTid, parentTid, 'sandbox realm does not use the parent or workload thread');
  });
});

describe('Sandbox Realm enforcement', { exclusive: true }, () => {
  it('applies seccomp only to the dedicated thread', async (t) => {
    if (os !== 'linux') return;
    const libc = dlopen('libc.so.6', {
      getpid: {
        parameters: [],
        result: 'i32',
      },
    });
    const parentPid = Number(libc.symbols.getpid());
    using realm = new Realm<typeof sandboxSyncGetpid>({
      entry: new URL('./fixtures/sandbox-sync-getpid-fn.ts', import.meta.url).pathname,
      sandbox: {
        mode: 'strict',
        syscalls: { mode: 'denylist', names: ['getpid'] },
      },
    });
    t.equal(await realm.call(), -1, 'denied syscall returns EPERM in the sandbox thread');
    t.equal(
      Number(libc.symbols.getpid()),
      parentPid,
      'the parent thread remains outside the seccomp filter',
    );
  });

  it('rejects async FFI that would escape to the global blocking pool', async (t) => {
    if (os !== 'linux') return;
    using realm = new Realm<typeof sandboxAsyncFfi>({
      entry: new URL('./fixtures/sandbox-async-ffi-fn.ts', import.meta.url).pathname,
      sandbox: { mode: 'strict' },
    });
    const message = await realm.call();
    t.ok(
      /async FFI.*sandbox Realm|blocking pool/i.test(message),
      'async FFI fails before work is submitted outside the policy',
    );
  });

  it('force-cleans a sandbox while it is still initializing', async (t) => {
    if (os !== 'linux') return;
    const realm = new Realm<typeof sandboxBusyLoop>({
      entry: new URL('./fixtures/sandbox-busy-loop-fn.ts', import.meta.url).pathname,
      sandbox: { mode: 'strict' },
    });
    const call = realm.call();
    realm.terminate({ force: true });
    const result = await Promise.race([
      call.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 1000)),
    ]);
    t.equal(result, 'rejected', 'an early force request settles the call promptly');
  });

  it('keeps peer Realms responsive and force-cleans a non-yielding sandbox', async (t) => {
    if (os !== 'linux') return;
    const realm = new Realm<typeof sandboxBusyLoop>({
      entry: new URL('./fixtures/sandbox-busy-loop-fn.ts', import.meta.url).pathname,
      sandbox: {
        mode: 'strict',
        resources: { cpu: 0.25 },
      },
    });
    const call = realm.call();
    const peerEntry = new URL('./fixtures/echo-fn.ts', import.meta.url).pathname;
    const peers = Array.from({ length: 4 }, () => new Realm<typeof echo>({ entry: peerEntry }));
    // Fresh isolate groups can spend over a second instantiating their module
    // graphs on an otherwise idle debug build. Keep the deadline bounded while
    // leaving enough room to test scheduler responsiveness rather than cold
    // isolate startup speed.
    const peerDeadlineMs = 5_000;
    const peerStart = performance.now();
    const peerResult = await Promise.race([
      Promise.all(peers.map((peer, index) => peer.call(index))),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), peerDeadlineMs)),
    ]);
    t.equal(
      JSON.stringify(peerResult),
      JSON.stringify([0, 1, 2, 3]),
      'regular workload peers complete while the CPU-capped sandbox is busy',
    );
    t.ok(
      performance.now() - peerStart < peerDeadlineMs,
      'peer latency remains bounded by the test deadline',
    );
    realm.terminate({ force: true });
    const result = await Promise.race([
      call.then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
    ]);
    t.equal(result, 'rejected', 'forced termination settles within the cleanup deadline');
  });

  it('joins a threaded cgroup for CPU and pid controls, or fails closed', async (t) => {
    if (os !== 'linux') return;
    using realm = new Realm<typeof linuxThreadId>({
      entry: new URL('./fixtures/linux-thread-id-fn.ts', import.meta.url).pathname,
      sandbox: {
        mode: 'strict',
        resources: { cpu: 0.5, pids: 32 },
      },
    });
    try {
      t.ok((await realm.call()) > 0, 'resource-governed sandbox thread runs to completion');
    } catch (error) {
      t.ok(
        /cgroup.*delegated|delegated cgroup|threaded (cpu|pids) controller/i.test(String(error)),
        `missing threaded cgroup delegation fails closed: ${String(error)}`,
      );
    }
  });

  it(
    'confines execution to the requested cgroup cpuset, or fails closed',
    {
      skip:
        parentRealmPort === undefined
          ? false
          : 'threaded cpuset setup requires the root Realm cgroup domain',
    },
    async (t) => {
      if (os !== 'linux') return;
      const libc = dlopen('libc.so.6', {
        sched_getcpu: {
          parameters: [],
          result: 'i32',
        },
      });
      const cpu = Number(libc.symbols.sched_getcpu());
      using realm = new Realm<typeof linuxCpuId>({
        entry: new URL('./fixtures/linux-cpu-id-fn.ts', import.meta.url).pathname,
        sandbox: {
          mode: 'strict',
          resources: { cpus: String(cpu) },
        },
      } as any);
      try {
        t.equal(await realm.call(), cpu, 'sandbox thread executes only on its requested CPU');
      } catch (error) {
        t.ok(
          /cgroup.*delegated|delegated threaded cpuset|cpuset controller/i.test(String(error)),
          `missing threaded cpuset delegation fails closed: ${String(error)}`,
        );
      }
    },
  );

  it('applies Landlock only to the dedicated thread, or fails closed', async (t) => {
    if (os !== 'linux') return;
    const repoRoot = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
    using realm = new Realm<typeof sandboxOpen>({
      entry: new URL('./fixtures/sandbox-open-fn.ts', import.meta.url).pathname,
      sandbox: {
        mode: 'strict',
        filesystem: { readonly: [repoRoot] },
      },
    });
    const landlockAvailable = processSandboxCapabilities().backends.some(
      (backend) => backend.name === 'linuxNative' && backend.supported.includes('filesystem'),
    );
    if (!landlockAvailable) {
      await t.rejects(
        () => realm.call('/etc/hostname'),
        /Landlock/,
        'missing Landlock fails closed',
      );
      return;
    }
    t.equal(await realm.call('/etc/hostname'), -1, 'sandbox thread cannot open an unlisted path');
    const libc = dlopen('libc.so.6', {
      open: {
        parameters: ['buffer', 'i32', 'i32'],
        result: 'i32',
        variadic: 2,
      },
      close: {
        parameters: ['i32'],
        result: 'i32',
      },
    });
    const bytes = new TextEncoder().encode('/etc/hostname');
    const path = new Uint8Array(bytes.length + 1);
    path.set(bytes);
    const fd = Number(libc.symbols.open(path, 0, 0));
    t.ok(fd >= 0, 'parent thread can still open the same path');
    if (fd >= 0) libc.symbols.close(fd);
  });
});
