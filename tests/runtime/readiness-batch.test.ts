import { describe, it } from 'fino:test/test';
import * as backend from 'internal:runtime/loop-backend';
import { os } from 'internal:process';

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
  if (os === 'linux') {
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
