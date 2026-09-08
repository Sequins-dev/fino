import { describe, it } from 'fino:test/test';
import * as backend from 'internal:runtime/loop-backend';
import { os } from 'internal:process';
import { dlopen } from 'fino:ffi';

describe('Readiness registration batches', () => {
  it('installs timers after cancelling an absent watch in a full batch', (t) => {
    const raw = backend.create();
    try {
      backend.removeTimer(raw, 999999);
      for (let id = 1; id <= 64; id++) backend.addTimer(raw, id, 1);
      const received = new Set<number>();
      const deadline = Date.now() + 1000;
      while (received.size < 64 && Date.now() < deadline) {
        for (const event of backend.wait(raw, 10)) {
          if (event.filter === backend.EVFILT_TIMER) received.add(event.ident);
        }
      }
      t.equal(received.size, 64, 'every timer after the absent cancellation fires');
    } finally {
      backend.destroy(raw);
    }
  });
  it('preserves ready one-shot events across a registration-only flush', async (t) => {
    const raw = backend.create();
    try {
      backend.addTimer(raw, 1, 1);
      backend.flush(raw);
      await new Promise((resolve) => setTimeout(resolve, 20));
      backend.removeTimer(raw, 999999);
      backend.addTimer(raw, 2, 1);
      backend.flush(raw);
      const received = new Set<number>();
      const deadline = Date.now() + 1000;
      while (received.size < 2 && Date.now() < deadline) {
        for (const event of backend.wait(raw, 10)) {
          if (event.filter === backend.EVFILT_TIMER) received.add(event.ident);
        }
      }
      t.deepEqual([...received].sort(), [1, 2], 'both the ready and newly armed timer fire');
    } finally {
      backend.destroy(raw);
    }
  });
  if (os === 'darwin') {
    it('keeps a delegated vnode watch attached to its original resource', async (t) => {
      const loop = await import('internal:runtime/loop');
      const { DiskFileSystem } = await import('fino:file');
      const fs = new DiskFileSystem();
      const path = '/tmp/fino-vnode-borrow-' + crypto.randomUUID();
      await fs.writeFile(path, new Uint8Array([1]));
      const libc = dlopen('/usr/lib/libSystem.B.dylib', {
        open: { parameters: ['buffer', 'i32', 'i32'], result: 'i32', variadic: 2 },
        pipe: { parameters: ['buffer'], result: 'i32' },
        dup2: { parameters: ['i32', 'i32'], result: 'i32' },
        close: { parameters: ['i32'], result: 'i32' },
      });
      const fd = Number(libc.symbols.open(new TextEncoder().encode(path + '\0').buffer, 0, 0));
      t.ok(fd >= 0);
      const pipe = new Int32Array(2);
      t.equal(libc.symbols.pipe(pipe.buffer), 0);
      let notify!: () => void;
      const event = new Promise<void>((resolve) => (notify = resolve));
      const timer = loop.timeout(10_000);
      try {
        const installed = loop.vnode(fd, 2, () => notify());
        // Reuse the caller's number before awaiting the controller receipt.
        // If installation won the race, dup2 removes the old unretained
        // filter; if it lost, installing EVFILT_VNODE on a pipe fails.
        t.equal(libc.symbols.dup2(pipe[0], fd), fd);
        await installed;
        await fs.writeFile(path, new Uint8Array([2]));
        t.equal(await Promise.race([event.then(() => true), timer.then(() => false)]), true);
      } finally {
        timer.cancel();
        loop.removeVnode(fd);
        libc.symbols.close(fd);
        libc.symbols.close(pipe[0]);
        libc.symbols.close(pipe[1]);
        await fs.unlink(path);
      }
    });
    it('discards cancelled pending watches before descriptor reuse', (t) => {
      const libc = dlopen('/usr/lib/libSystem.B.dylib', {
        pipe: { parameters: ['buffer'], result: 'i32' },
        dup2: { parameters: ['i32', 'i32'], result: 'i32' },
        close: { parameters: ['i32'], result: 'i32' },
      });
      for (const flushFirst of [false, true]) {
        const raw = backend.create();
        const descriptors = new Int32Array(2);
        t.equal(libc.symbols.pipe(descriptors.buffer), 0);
        const [read, write] = descriptors;
        try {
          backend.addRead(raw, read, 123);
          backend.removeRead(raw, read);
          // Model close/reuse before the controller submits its queued changes.
          // Watching a duplicate of this kqueue itself deterministically fails
          // with EINVAL if the cancelled ADD still reaches the kernel.
          t.equal(libc.symbols.dup2((raw as { fd: number }).fd, read), read);
          if (flushFirst) backend.flush(raw);
          t.deepEqual(backend.wait(raw, 0), []);
        } finally {
          libc.symbols.close(read);
          libc.symbols.close(write);
          backend.destroy(raw);
        }
      }
    });
    it('keeps the replacement watch when pending changes share a descriptor', (t) => {
      const libc = dlopen('/usr/lib/libSystem.B.dylib', {
        pipe: { parameters: ['buffer'], result: 'i32' },
        write: { parameters: ['i32', 'buffer', 'u64'], result: 'i64' },
        close: { parameters: ['i32'], result: 'i32' },
      });
      const raw = backend.create();
      const descriptors = new Int32Array(2);
      t.equal(libc.symbols.pipe(descriptors.buffer), 0);
      const [read, write] = descriptors;
      try {
        backend.addRead(raw, read, 123);
        backend.removeRead(raw, read);
        backend.addRead(raw, read, 456);
        libc.symbols.write(write, new Uint8Array([1]).buffer, 1);
        const events = backend.wait(raw, 1000);
        t.equal(events.length, 1);
        t.equal(events[0]?.udata, 456);
      } finally {
        libc.symbols.close(read);
        libc.symbols.close(write);
        backend.destroy(raw);
      }
    });
  }
  if (os === 'linux') {
    it('releases a cancelled kernel poll before the descriptor is closed', async (t) => {
      const uring = await import('internal:runtime/io_uring');
      const libc = dlopen('libc.so.6', {
        socketpair: { parameters: ['i32', 'i32', 'i32', 'buffer'], result: 'i32' },
        read: { parameters: ['i32', 'buffer', 'u64'], result: 'i64' },
        close: { parameters: ['i32'], result: 'i32' },
      });
      const descriptors = new Int32Array(2);
      // SOCK_NONBLOCK lets the peer distinguish EOF from an outstanding poll
      // that still holds the other endpoint's open-file reference.
      t.equal(libc.symbols.socketpair(1, 1 | 2048, 0, descriptors.buffer), 0);
      const [watched, peer] = descriptors;
      const raw = uring.create(8);
      let open = true;
      try {
        uring.addRead(raw, watched, 123);
        uring.flush(raw);
        uring.removeRead(raw, watched);
        uring.flush(raw);
        libc.symbols.close(watched);
        open = false;
        const buffer = new ArrayBuffer(1);
        let result = -1;
        const deadline = performance.now() + 1000;
        while (performance.now() < deadline) {
          uring.poll(raw);
          result = Number(libc.symbols.read(peer, buffer, 1));
          if (result === 0) break;
        }
        t.equal(result, 0, 'peer observes EOF after cancelling the quiet poll');
      } finally {
        uring.destroy(raw);
        if (open) libc.symbols.close(watched);
        libc.symbols.close(peer);
      }
    });
    it('preserves io_uring completion identities across queue wrap and cancellation', async (t) => {
      const uring = await import('internal:runtime/io_uring');
      const ring = uring.create(8);
      const seen = new Set<number>();
      let duplicate = false;
      let unexpected = false;
      try {
        for (let round = 0; round < 256; round++) {
          const base = round * 9 + 1;
          uring.addTimer(ring, base + 8, 10_000);
          uring.removeTimer(ring, base + 8);
          for (let offset = 0; offset < 8; offset++) uring.addTimer(ring, base + offset, 1);
          uring.flush(ring);
          const deadline = Date.now() + 2_000;
          while (seen.size < (round + 1) * 8 && Date.now() < deadline) {
            for (const event of uring.poll(ring)) {
              if (
                event.filter !== uring.EVFILT_TIMER ||
                event.ident < base ||
                event.ident >= base + 8
              )
                unexpected = true;
              if (seen.has(event.ident)) duplicate = true;
              seen.add(event.ident);
            }
          }
          if (seen.size !== (round + 1) * 8)
            throw new Error('missing completion at round ' + round);
        }
        t.equal(seen.size, 2048);
        t.equal(duplicate, false);
        t.equal(unexpected, false);
      } finally {
        uring.destroy(ring);
      }
    });
  }
});
