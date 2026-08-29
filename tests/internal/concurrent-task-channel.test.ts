import { describe, it } from 'fino:test/test';
import { ConcurrentTaskChannel } from 'internal:concurrent-task-channel';

describe('ConcurrentTaskChannel', () => {
  it('claims immediately, bounds scheduled tasks, and emits completion order', async (t) => {
    const channel = new ConcurrentTaskChannel<string>(2);
    const first = channel.claim();
    const second = channel.claim();
    const third = channel.claim();

    t.deepEqual([first.index, second.index, third.index], [0, 1, 2]);
    t.equal(channel.active, 0, 'claiming positions does not schedule work');

    await Promise.all([first.schedule(), second.schedule()]);
    let thirdScheduled = false;
    const thirdSchedule = third.schedule().then(() => {
      thirdScheduled = true;
    });
    await Promise.resolve();
    t.equal(channel.active, 2, 'capacity counts scheduled, unsettled tasks');
    t.equal(thirdScheduled, false, 'another schedule waits at capacity');

    second.resolve('second');
    await thirdSchedule;
    t.equal(channel.active, 2, 'new work reuses released capacity');
    third.resolve('third');
    first.resolve('first');
    channel.close();

    const values: string[] = [];
    for await (const value of channel) values.push(value);
    t.deepEqual(values, ['second', 'third', 'first'], 'settled values emit immediately');
    t.equal(channel.active, 0, 'all capacity is released after settlement');
  });

  it('optionally preserves claim order', async (t) => {
    const channel = new ConcurrentTaskChannel<string>(2, { outputOrder: 'claim' });
    const first = channel.claim();
    const second = channel.claim();
    await Promise.all([first.schedule(), second.schedule()]);
    second.resolve('second');
    first.resolve('first');
    channel.close();

    const values: string[] = [];
    for await (const value of channel) values.push(value);
    t.deepEqual(values, ['first', 'second'], 'claim order waits for earlier positions');
  });

  it('schedules claimed positions after close and rejects later claims', async (t) => {
    const channel = new ConcurrentTaskChannel<number>(1);
    const first = channel.claim();
    const second = channel.claim();
    channel.close();
    t.throws(() => channel.claim(), /closed/, 'claims made after close throw');

    await first.schedule();
    const secondSchedule = second.schedule();
    first.resolve(1);
    await secondSchedule;
    second.resolve(2);

    t.deepEqual(
      [await channel.next(), await channel.next(), await channel.next()],
      [
        { value: 1, done: false },
        { value: 2, done: false },
        { value: undefined, done: true },
      ],
    );
    channel.close();
  });

  it('rejects one output position without stalling the next', async (t) => {
    const channel = new ConcurrentTaskChannel<string>(1);
    const first = channel.claim();
    const second = channel.claim();
    const expected = new Error('expected rejection');
    await first.schedule();
    const secondSchedule = second.schedule();
    first.reject(expected);
    await secondSchedule;
    second.resolve('recovered');
    channel.close();

    await t.rejects(() => channel.next(), /expected rejection/);
    t.deepEqual(await channel.next(), { value: 'recovered', done: false });
    t.deepEqual(await channel.next(), { value: undefined, done: true });
  });

  it('runs an exclusive task only after active work drains', async (t) => {
    const channel = new ConcurrentTaskChannel<string>(3);
    const first = channel.claim();
    const exclusive = channel.claim();
    const last = channel.claim();
    await first.schedule();
    let exclusiveScheduled = false;
    let lastScheduled = false;
    const exclusiveSchedule = exclusive.schedule({ exclusive: true }).then(() => {
      exclusiveScheduled = true;
    });
    const lastSchedule = last.schedule().then(() => {
      lastScheduled = true;
    });
    await Promise.resolve();
    t.equal(exclusiveScheduled, false, 'exclusive work waits for active work');
    t.equal(lastScheduled, false, 'later work waits behind exclusive work');
    first.resolve('first');
    await exclusiveSchedule;
    t.equal(channel.active, 3, 'exclusive work reserves the full capacity');
    exclusive.resolve('exclusive');
    await lastSchedule;
    t.equal(channel.active, 1, 'ordinary work resumes after exclusivity');
    last.resolve('last');
    channel.close();
    const values: string[] = [];
    for await (const value of channel) values.push(value);
    t.deepEqual(values, ['first', 'exclusive', 'last']);
  });

  it('treats an exclusive claim as a barrier while its dependency is pending', async (t) => {
    const channel = new ConcurrentTaskChannel<string>(2);
    const exclusive = channel.claim();
    const later = channel.claim();
    let releaseExclusive!: () => void;
    const ready = new Promise<void>((resolve) => {
      releaseExclusive = resolve;
    });
    const exclusiveSchedule = exclusive.schedule({ exclusive: true, ready });
    let laterScheduled = false;
    const laterSchedule = later.schedule().then(() => {
      laterScheduled = true;
    });
    await Promise.resolve();
    t.equal(laterScheduled, false, 'later work cannot cross a pending exclusive claim');
    releaseExclusive();
    await exclusiveSchedule;
    exclusive.resolve('exclusive');
    await laterSchedule;
    later.resolve('later');
    channel.close();
    const values: string[] = [];
    for await (const value of channel) values.push(value);
    t.deepEqual(values, ['exclusive', 'later']);
  });

  it('admits the earliest ready claim without blocking on a dependency', async (t) => {
    const channel = new ConcurrentTaskChannel<string>(2);
    const first = channel.claim();
    const second = channel.claim();
    const third = channel.claim();
    let releaseFirst!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstScheduled = false;
    const firstSchedule = first.schedule({ ready: firstReady }).then(() => {
      firstScheduled = true;
    });
    await Promise.all([second.schedule(), third.schedule()]);
    t.equal(firstScheduled, false, 'a blocked dependency does not consume capacity');
    second.resolve('second');
    third.resolve('third');
    releaseFirst();
    await firstSchedule;
    first.resolve('first');
    channel.close();
    const values: string[] = [];
    for await (const value of channel) values.push(value);
    t.deepEqual(values, ['second', 'third', 'first'], 'ready tasks emit as they complete');
  });

  it('requires scheduling before settlement and schedules only once', async (t) => {
    const channel = new ConcurrentTaskChannel<number>(1);
    const resolver = channel.claim();
    t.throws(() => resolver.resolve(1), /scheduled before settlement/);
    const firstSchedule = resolver.schedule();
    t.equal(resolver.schedule(), firstSchedule, 'schedule is idempotent');
    await firstSchedule;
    resolver.resolve(1);
    resolver.resolve(2);
    channel.close();
    t.deepEqual(await channel.next(), { value: 1, done: false });
  });

  it('requires a positive integer capacity', (t) => {
    for (const capacity of [0, -1, 1.5, Number.NaN]) {
      t.throws(() => new ConcurrentTaskChannel(capacity), /positive integer/);
    }
    t.equal(new ConcurrentTaskChannel(1).capacity, 1);
  });
});
