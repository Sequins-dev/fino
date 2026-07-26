/**
 * Tests for fino:context/topic — Topic pub/sub and async iterator.
 */
import { describe, it } from 'fino:test/test';
import { subscribeMatching, topic } from 'fino:context/topic';
describe('Topic async iterator', () => {
  it('yields published messages in order', async (t) => {
    const ch = topic('test:iter-order-' + Math.random());
    const iter = ch[Symbol.asyncIterator]();
    ch.publish(1);
    ch.publish(2);
    ch.publish(3);
    const r1 = await iter.next();
    const r2 = await iter.next();
    const r3 = await iter.next();
    t.equal(r1.value, 1, 'first message');
    t.equal(r2.value, 2, 'second message');
    t.equal(r3.value, 3, 'third message');
    t.ok(!r1.done && !r2.done && !r3.done, 'none are done');
    iter.return!();
  });
  it('buffers messages published while consumer is busy', async (t) => {
    const ch = topic('test:iter-buffer-' + Math.random());
    const received: number[] = [];
    const done = (async () => {
      for await (const msg of ch) {
        received.push(msg as number);
        if (received.length === 3) break;
      }
    })();
    // Publish before the iterator has a chance to await
    ch.publish(10);
    ch.publish(20);
    ch.publish(30);
    await done;
    t.deepEqual(received, [10, 20, 30], 'all messages received in order');
  });
  it('return() disposes subscription and resolves pending next()', async (t) => {
    const ch = topic('test:iter-return-' + Math.random());
    const iter = ch[Symbol.asyncIterator]();
    // next() with no published message — will be pending
    const pending = iter.next();
    const result = await iter.return!();
    t.ok(result.done, 'return() resolves with done=true');
    // pending next() should also resolve as done
    const pendingResult = await pending;
    t.ok(pendingResult.done, 'pending next() resolved as done after return()');
    // No more subscribers
    t.ok(!ch.hasSubscribers, 'subscription disposed after return()');
  });
  it('return() disposes subscription and drops queued messages', async (t) => {
    const ch = topic('test:iter-return-queued-' + Math.random());
    const iter = ch[Symbol.asyncIterator]();
    ch.publish('queued');
    const returned = await iter.return!();
    const next = await iter.next();
    t.ok(returned.done, 'return() completes the iterator');
    t.ok(next.done, 'queued messages are not delivered after return()');
    t.ok(!ch.hasSubscribers, 'subscription disposed after queued return');
  });
  it('multiple independent iterators each receive all messages', async (t) => {
    const ch = topic('test:iter-multi-' + Math.random());
    const iter1 = ch[Symbol.asyncIterator]();
    const iter2 = ch[Symbol.asyncIterator]();
    ch.publish('hello');
    const r1 = await iter1.next();
    const r2 = await iter2.next();
    t.equal(r1.value, 'hello', 'iter1 received message');
    t.equal(r2.value, 'hello', 'iter2 received message');
    iter1.return!();
    iter2.return!();
  });
  it('for-await-of break cleans up subscription', async (t) => {
    const ch = topic('test:iter-break-' + Math.random());
    // Start the loop (subscribes), then publish to unblock, then break.
    const done = (async () => {
      for await (const _ of ch) {
        break;
      }
    })();
    ch.publish('trigger');
    await done;
    t.ok(!ch.hasSubscribers, 'subscription disposed after break');
  });
  it('for-await-of yields messages and breaks at limit', async (t) => {
    const ch = topic('test:iter-limit-' + Math.random());
    const collected: number[] = [];
    const done = (async () => {
      for await (const msg of ch) {
        collected.push(msg as number);
        if (collected.length === 2) break;
      }
    })();
    ch.publish(1);
    ch.publish(2);
    ch.publish(3);
    await done;
    t.deepEqual(collected, [1, 2], 'only first two messages collected');
    t.ok(!ch.hasSubscribers, 'subscription disposed after break');
  });
  it('subscribeMatching attaches to existing and future topics by name', async (t) => {
    const seen: string[] = [];
    const existing = topic('test:match:existing:' + Math.random());
    const futureName = 'test:match:future:' + Math.random();
    const handle = subscribeMatching(
      (name) => name.startsWith('test:match:'),
      (message, topicName) => {
        seen.push(`${topicName}=${message}`);
      },
    );
    existing.publish('alpha');
    topic(futureName).publish('beta');
    topic('test:other:' + Math.random()).publish('ignored');
    handle.dispose();
    existing.publish('after');
    t.equal(seen.length, 2, 'matching subscriber sees existing and future topics');
    t.ok(seen[0]!.includes('alpha'), 'existing topic delivered');
    t.ok(seen[1]!.includes('beta'), 'future topic delivered');
  });
  it('delivers subscriber errors to execution-flow:error', (t) => {
    const errors = topic<{
      error: Error;
      topicName: string;
    }>('execution-flow:error');
    const source = topic('test:error-delivery-' + Math.random());
    const seen: Array<{
      message: string;
      topicName: string;
    }> = [];
    const handle = errors.subscribe((event) => {
      seen.push({
        message: event.error.message,
        topicName: event.topicName,
      });
    });
    try {
      source.subscribe(() => {
        throw new Error('subscriber failed');
      });
      source.publish('message');
    } finally {
      handle.dispose();
    }
    t.deepEqual(
      seen,
      [
        {
          message: 'subscriber failed',
          topicName: source.name,
        },
      ],
      'subscriber failures are published to execution-flow:error',
    );
  });
});
