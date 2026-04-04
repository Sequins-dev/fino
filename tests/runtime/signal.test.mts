/**
 * Tests for signal handling via fino:runtime/process signal() Topic API.
 */
import { describe, it } from 'fino:test/test';
import { signal, SIGUSR1, SIGUSR2, SIGTERM, pid, kill } from 'fino:runtime/process';

/** Wrap a one-shot topic delivery in a Promise. */
function nextSignal(name: string): Promise<unknown> {
  return new Promise((resolve) => {
    const t = signal(name);
    const handle = t.subscribe((evt) => {
      handle.dispose();
      resolve(evt);
    });
  });
}

describe('Signal handling', () => {
  it('SIGUSR1 topic fires on signal delivery', async (t) => {
    const received = nextSignal('SIGUSR1');
    kill(pid, SIGUSR1);
    const evt = await received as { signal: string; signo: number };
    t.equal(evt.signal, 'SIGUSR1', 'event.signal is SIGUSR1');
    t.equal(evt.signo, SIGUSR1, 'event.signo matches constant');
  });

  it('SIGUSR2 topic fires on signal delivery', async (t) => {
    const received = nextSignal('SIGUSR2');
    kill(pid, SIGUSR2);
    const evt = await received as { signal: string; signo: number };
    t.equal(evt.signal, 'SIGUSR2', 'event.signal is SIGUSR2');
    t.equal(evt.signo, SIGUSR2, 'event.signo matches constant');
  });

  it('signal() returns same Topic instance for same name', (t) => {
    const t1 = signal('SIGUSR1');
    const t2 = signal('SIGUSR1');
    t.equal(t1, t2, 'same Topic object returned on repeated calls');
  });

  it('signal() throws for unknown signal name', (t) => {
    t.throws(() => signal('SIGFOO'), /Unknown signal/, 'unknown signal name throws');
  });

  it('subscription handle.dispose() removes subscriber', (t) => {
    const t1 = signal('SIGTERM');
    const handle = t1.subscribe(() => {});
    t.ok(t1.hasSubscribers, 'topic has subscribers');
    handle.dispose();
    t.ok(!t1.hasSubscribers, 'topic has no subscribers after dispose');
  });

  it('multiple signals can be subscribed simultaneously', async (t) => {
    const p1 = nextSignal('SIGUSR1');
    const p2 = nextSignal('SIGUSR2');
    kill(pid, SIGUSR1);
    kill(pid, SIGUSR2);
    const [e1, e2] = await Promise.all([p1, p2]) as [{ signal: string }, { signal: string }];
    t.equal(e1.signal, 'SIGUSR1', 'first event is SIGUSR1');
    t.equal(e2.signal, 'SIGUSR2', 'second event is SIGUSR2');
  });
});
