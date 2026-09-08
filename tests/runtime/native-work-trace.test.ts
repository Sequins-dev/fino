import { describe, it } from 'fino:test/test';
import { dlopen, FfiCallback, Pointer } from 'fino:ffi';
import { os } from 'internal:process';
import {
  currentWorkloadOwner,
  readinessTraceSnapshot,
  recordReadinessTrace,
} from 'internal:scheduler-native';

describe('Native async work diagnostics', () => {
  it('retains a pending native operation until its originating resolver is consumed', async (t) => {
    const owner = currentWorkloadOwner();
    const snapshot = () => JSON.parse(readinessTraceSnapshot(owner));
    if (!snapshot().enabled) return;
    const libc = dlopen(os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
      pipe: { parameters: ['buffer'], result: 'i32' },
      read: { parameters: ['i32', 'buffer', 'usize'], result: 'isize', async: true },
      write: { parameters: ['i32', 'buffer', 'usize'], result: 'isize' },
      close: { parameters: ['i32'], result: 'i32' },
    });
    const fds = new Int32Array(2);
    t.equal(libc.symbols.pipe(fds.buffer), 0);
    let read: Promise<unknown> | undefined;
    try {
      const before = snapshot().nativeWork;
      t.ok(before, 'native work is observable separately from readiness');
      const oldIds = new Set(before.active.map((op) => op.id));
      read = libc.symbols.read(fds[0], new ArrayBuffer(1), 1);
      const pending = snapshot().nativeWork.active.find((op) => !oldIds.has(op.id));
      t.ok(pending, 'operation is visible before the native call finishes');
      t.equal(pending.owner, owner);
      t.equal(pending.kind, 'ffi');
      t.ok(['queued', 'running'].includes(pending.stage));
      libc.symbols.write(fds[1], new Uint8Array([1]).buffer, 1);
      await read;
      read = undefined;
      const after = snapshot().nativeWork;
      t.ok(!after.active.some((op) => op.id === pending.id));
      t.ok(after.recent.some((op) => op.id === pending.id && op.stage === 'resolver-consumed'));
    } finally {
      if (read) {
        libc.symbols.write(fds[1], new Uint8Array([1]).buffer, 1);
        await read;
      }
      libc.symbols.close(fds[0]);
      libc.symbols.close(fds[1]);
    }
  });

  it('distinguishes a native callback awaiting a JS promise from pending FFI work', async (t) => {
    const owner = currentWorkloadOwner();
    const snapshot = () => JSON.parse(readinessTraceSnapshot(owner));
    if (!snapshot().enabled) return;
    const libc = dlopen(os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
      qsort: { parameters: ['pointer', 'usize', 'usize', 'pointer'], result: 'void', async: true },
    });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const callback = new FfiCallback(
      { parameters: ['pointer', 'pointer'], result: 'i32' },
      async () => {
        entered();
        await gate;
        return 0;
      },
    );
    const values = new Int32Array([2, 1]);
    const work = libc.symbols.qsort(Pointer.of(values.buffer), 2n, 4n, callback.pointer);
    try {
      await started;
      const pending = snapshot().nativeWork.active;
      t.ok(pending.some((op) => op.kind === 'ffi' && op.stage === 'running'));
      t.ok(pending.some((op) => op.kind === 'callback' && op.stage === 'awaiting-promise'));
    } finally {
      release();
      await work;
      callback.close();
    }
    t.ok(!snapshot().nativeWork.active.some((op) => op.kind === 'callback'));
  });

  it('counts repeated native wake notifications without evicting operation history', (t) => {
    const owner = currentWorkloadOwner();
    if (!JSON.parse(readinessTraceSnapshot(owner)).enabled) return;
    const operation = 9_007_199_254_740_000 - owner;
    for (let index = 0; index < 2_000; index++) {
      recordReadinessTrace(operation, owner, 'wake-ready', 123, -1, owner);
      recordReadinessTrace(operation, owner, 'wake-owner-signalled', 123, -1, owner);
    }
    const snapshot = JSON.parse(readinessTraceSnapshot(owner));
    const wake = snapshot.wakeSources?.find((entry) => entry.operation === operation);
    t.ok(wake, 'wake notification totals are retained separately');
    t.equal(wake?.ready, 2_000);
    t.equal(wake?.signalled, 2_000);
    t.equal(snapshot.events.filter((entry) => entry.operation === operation).length, 0);
  });
});
