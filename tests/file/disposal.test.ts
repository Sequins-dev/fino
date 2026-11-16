/** Resource cleanup must finish even when work or flushing fails. */
import { describe, it } from 'fino:test/test';
import { File } from 'internal:file/handle';
import { dlopen } from 'fino:ffi';
import { os } from 'internal:process';
const libc = dlopen(os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  pipe: { parameters: ['buffer'], result: 'i32' },
  fcntl: { parameters: ['i32', 'i32', 'i32'], result: 'i32', variadic: 2 },
  read: { parameters: ['i32', 'buffer', 'usize'], result: 'isize' },
  close: { parameters: ['i32'], result: 'i32' },
});
function openPipe() {
  const fds = new Int32Array(2);
  if (libc.symbols.pipe(fds.buffer) !== 0) throw new Error('pipe failed');
  const nonblocking = os === 'darwin' ? 4 : 2048;
  if (
    libc.symbols.fcntl(fds[0], 4, nonblocking) !== 0 ||
    (libc.symbols.fcntl(fds[0], 3, 0) & nonblocking) === 0
  ) {
    libc.symbols.close(fds[0]);
    libc.symbols.close(fds[1]);
    throw new Error('nonblocking pipe setup failed');
  }
  const buffer = new ArrayBuffer(16);
  return {
    fd: fds[1],
    // EOF identifies this pipe's write endpoint even if its numeric descriptor
    // has already been reused by another concurrently running Realm.
    closed() {
      let count: number;
      do {
        count = Number(libc.symbols.read(fds[0], buffer, buffer.byteLength));
      } while (count > 0);
      return count === 0;
    },
    [Symbol.dispose]() {
      if (!this.closed()) libc.symbols.close(fds[1]);
      libc.symbols.close(fds[0]);
    },
  };
}

describe('File disposal after failures', () => {
  // Process entrypoints now use the same reactor driver; there is no separate
  // process-main JavaScript event loop to exercise here.

  for (const sync of [false, true]) {
    it(`releases the descriptor when ${sync ? 'synchronous' : 'asynchronous'} writer flushing throws`, async (t) => {
      using pipe = openPipe();
      const fd = pipe.fd;
      t.ok(fd >= 0);
      const file = new File(fd, {}, '/test-pipe', 'w');
      const writer = file.writer();
      const failure = new Error('injected flush failure');
      writer.flush = async () => {
        throw failure;
      };
      writer.flushSync = () => {
        throw failure;
      };
      let caught;
      try {
        if (sync) file.closeSync();
        else {
          await using scoped = file;
        }
      } catch (error) {
        caught = error;
      }
      t.equal(caught, failure, 'the original flush failure is preserved');
      t.equal(pipe.closed(), true, 'cleanup releases the actual OS handle');
    });
  }
  it('disposes the descriptor when the using block throws', async (t) => {
    using pipe = openPipe();
    const fd = pipe.fd;
    const failure = new Error('body failed');
    let caught;
    try {
      await using file = new File(fd, {}, '/test-pipe', 'w');
      await file.writer().write(new Uint8Array([1]));
      throw failure;
    } catch (error) {
      caught = error;
    }
    t.equal(caught, failure);
    t.equal(pipe.closed(), true);
  });
  it('preserves both the body exception and a disposal failure', async (t) => {
    using pipe = openPipe();
    const bodyFailure = new Error('body failed');
    const flushFailure = new Error('flush failed');
    let caught;
    try {
      await using file = new File(pipe.fd, {}, '/test-pipe', 'w');
      file.writer().flush = async () => {
        throw flushFailure;
      };
      throw bodyFailure;
    } catch (error) {
      caught = error;
    }
    t.equal(caught.name, 'SuppressedError');
    t.equal(caught.error, flushFailure);
    t.equal(caught.suppressed, bodyFailure);
    t.equal(pipe.closed(), true);
  });
  it('awaits a close already in progress when disposing after an exception', async (t) => {
    using pipe = openPipe();
    const fd = pipe.fd;
    const file = new File(fd, {}, '/test-pipe', 'w');
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    file.writer().flush = () => gate;
    const closing = file.close();
    let disposed = false;
    const failure = new Error('body failed during close');
    const scope = (async () => {
      await using scoped = file;
      throw failure;
    })().catch((error) => {
      t.equal(error, failure);
      disposed = true;
    });
    try {
      // Drain promise reactions, without an unrelated OS readiness wake.
      for (let step = 0; step < 10; step++) await Promise.resolve();
      t.equal(disposed, false, 'disposing cannot complete before the descriptor closes');
      release();
      await Promise.all([closing, scope]);
      t.equal(disposed, true);
      t.equal(pipe.closed(), true);
    } finally {
      release();
      await Promise.allSettled([closing, scope]);
    }
  });
});
