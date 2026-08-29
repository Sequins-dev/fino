import { describe, it } from 'fino:test/test';
import { AsyncChannel, AsyncChannelClosedError } from 'internal:async-channel';

describe('AsyncChannel lifecycle', () => {
  it('delivers send-before-wait and wait-before-send values in FIFO order', async (t) => {
    const buffered = new AsyncChannel<number>();
    await buffered.send(1);
    await buffered.send(2);
    t.deepEqual(await buffered.receive(), { done: false, value: 1 });
    t.deepEqual(await buffered.receive(), { done: false, value: 2 });

    const waiting = new AsyncChannel<number>({ capacity: 0 });
    const first = waiting.receive();
    const second = waiting.receive();
    await Promise.all([waiting.send(3), waiting.send(4)]);
    t.deepEqual(await first, { done: false, value: 3 });
    t.deepEqual(await second, { done: false, value: 4 });
  });

  it('applies weighted capacity and FIFO producer backpressure', async (t) => {
    const channel = new AsyncChannel<string>({
      capacity: 3,
      weight: (value) => value.length,
    });
    await channel.send('abc');
    let admitted = false;
    const blocked = channel.send('d').then(() => {
      admitted = true;
    });
    await Promise.resolve();
    t.equal(admitted, false, 'send waits while weighted capacity is full');
    t.equal(channel.trySend('e'), false, 'trySend cannot bypass an earlier producer');
    t.deepEqual(await channel.receive(), { done: false, value: 'abc' });
    await blocked;
    t.equal(channel.bufferedWeight, 1, 'released capacity admits the oldest producer');
    t.deepEqual(await channel.receive(), { done: false, value: 'd' });
  });

  it('drains admitted values on close and makes terminal cleanup idempotent', async (t) => {
    const channel = new AsyncChannel<number>({ capacity: 2 });
    await channel.send(1);
    await channel.send(2);
    channel.close();
    channel.fail(new Error('late failure'));
    channel.close();
    t.deepEqual(await channel.next(), { done: false, value: 1 });
    t.deepEqual(await channel.next(), { done: false, value: 2 });
    t.deepEqual(await channel.next(), { done: true, value: undefined });
    await t.rejects(
      () => channel.send(3),
      AsyncChannelClosedError,
      'send after graceful close rejects',
    );

    const waiting = new AsyncChannel<number>();
    const receive = waiting.receive();
    waiting.close();
    t.deepEqual(await receive, { done: true, value: undefined }, 'close settles waiting receivers');

    const full = new AsyncChannel<number>({ capacity: 1 });
    await full.send(1);
    const blocked = full.send(2);
    const rejected = t.rejects(() => blocked, AsyncChannelClosedError);
    full.close();
    await rejected;
  });

  it('fails immediately, discards buffered values, and preserves the reason', async (t) => {
    const channel = new AsyncChannel<number>();
    await channel.send(1);
    const reason = new Error('upstream failed');
    channel.fail(reason);
    channel.close();
    let received: unknown;
    try {
      await channel.receive();
    } catch (error) {
      received = error;
    }
    t.equal(received, reason, 'receive rejects with the exact failure reason');
    t.equal(channel.bufferedItems, 0, 'failure releases buffered values');

    const waiting = new AsyncChannel<number>();
    const pending = waiting.receive();
    waiting.fail(reason);
    let pendingReason: unknown;
    try {
      await pending;
    } catch (error) {
      pendingReason = error;
    }
    t.equal(pendingReason, reason, 'failure rejects a waiting receiver');
  });

  it('removes aborted producers and consumers without disturbing later work', async (t) => {
    const channel = new AsyncChannel<number>({ capacity: 1 });
    await channel.send(1);
    const sendAbort = new AbortController();
    const blockedSend = channel.send(2, { signal: sendAbort.signal });
    sendAbort.abort(new Error('cancel send'));
    await t.rejects(() => blockedSend, /cancel send/);
    t.deepEqual(await channel.receive(), { done: false, value: 1 });

    const receiveAbort = new AbortController();
    const blockedReceive = channel.receive({ signal: receiveAbort.signal });
    receiveAbort.abort(new Error('cancel receive'));
    await t.rejects(() => blockedReceive, /cancel receive/);

    const winningReceiveAbort = new AbortController();
    const receive = channel.receive({ signal: winningReceiveAbort.signal });
    await channel.send(3);
    winningReceiveAbort.abort(new Error('too late'));
    t.deepEqual(await receive, { done: false, value: 3 }, 'settlement wins the abort race');
  });

  it('rendezvous sends and iterator cancellation settle every waiter', async (t) => {
    const rendezvous = new AsyncChannel<number>({ capacity: 0 });
    let sent = false;
    const send = rendezvous.send(1).then(() => {
      sent = true;
    });
    await Promise.resolve();
    t.equal(sent, false, 'zero-capacity send waits for a receiver');
    t.deepEqual(await rendezvous.receive(), { done: false, value: 1 });
    await send;

    const channel = new AsyncChannel<number>({ capacity: 1 });
    await channel.send(1);
    const blocked = channel.send(2);
    const blockedRejected = t.rejects(
      () => blocked,
      AsyncChannelClosedError,
      'pending producer rejects on iterator return',
    );
    await channel.return();
    await blockedRejected;
    t.equal(channel.bufferedItems, 0, 'iterator return releases buffered values');
    t.deepEqual(await channel.next(), { done: true, value: undefined });
    await channel.return();

    const iterated = new AsyncChannel<number>();
    await iterated.send(1);
    await iterated.send(2);
    for await (const value of iterated) {
      t.equal(value, 1, 'iterator yields the first value');
      break;
    }
    t.equal(iterated.closed, true, 'breaking iteration invokes channel return');
    t.equal(iterated.bufferedItems, 0, 'early iteration releases the remainder');
  });

  it('validates capacity and caller-provided weights', (t) => {
    for (const capacity of [-1, 1.5, Number.NaN]) {
      t.throws(() => new AsyncChannel({ capacity }), /capacity/);
    }
    const channel = new AsyncChannel<number>({ weight: () => -1 });
    t.throws(() => channel.trySend(1), /weight/);
    t.throws(() => channel.send(1), /weight/);
  });
});
