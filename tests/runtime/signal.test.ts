/**
 * Tests for signal handling via fino:process signal() Topic API.
 */
import { describe, it } from 'fino:test/test';
import { signal, signalArmed, SIGUSR1, SIGUSR2, SIGTERM, SIGWINCH, pid, kill } from 'fino:process';
/**
 * Subscribe to `name` and resolve once the watch is armed.
 *
 * The watch is installed by the realm that owns the process event loop, so a
 * signal raised before `signalArmed()` resolves would race the installation and
 * be dropped. The one-shot delivery promise is returned inside an object so
 * awaiting the arming does not also await the delivery.
 */
async function armSignal(name: string): Promise<{ received: Promise<unknown> }> {
  const received = new Promise((resolve) => {
    const t = signal(name);
    const handle = t.subscribe((evt) => {
      handle.dispose();
      resolve(evt);
    });
  });
  await signalArmed(name);
  return { received };
}
describe('Signal handling', () => {
  it('SIGUSR1 topic fires on signal delivery', async (t) => {
    const { received } = await armSignal('SIGUSR1');
    kill(pid, SIGUSR1);
    const evt = (await received) as {
      signal: string;
      signo: number;
    };
    t.equal(evt.signal, 'SIGUSR1', 'event.signal is SIGUSR1');
    t.equal(evt.signo, SIGUSR1, 'event.signo matches constant');
  });
  it('SIGUSR2 topic fires on signal delivery', async (t) => {
    const { received } = await armSignal('SIGUSR2');
    kill(pid, SIGUSR2);
    const evt = (await received) as {
      signal: string;
      signo: number;
    };
    t.equal(evt.signal, 'SIGUSR2', 'event.signal is SIGUSR2');
    t.equal(evt.signo, SIGUSR2, 'event.signo matches constant');
  });
  it('SIGWINCH topic fires on signal delivery', async (t) => {
    const { received } = await armSignal('SIGWINCH');
    kill(pid, SIGWINCH);
    const evt = (await received) as { signal: string; signo: number };
    t.equal(evt.signal, 'SIGWINCH', 'event.signal is SIGWINCH');
    t.equal(evt.signo, SIGWINCH, 'event.signo matches constant');
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
    const { received: p1 } = await armSignal('SIGUSR1');
    const { received: p2 } = await armSignal('SIGUSR2');
    kill(pid, SIGUSR1);
    kill(pid, SIGUSR2);
    const [e1, e2] = (await Promise.all([p1, p2])) as [
      {
        signal: string;
      },
      {
        signal: string;
      },
    ];
    t.equal(e1.signal, 'SIGUSR1', 'first event is SIGUSR1');
    t.equal(e2.signal, 'SIGUSR2', 'second event is SIGUSR2');
  });
});
