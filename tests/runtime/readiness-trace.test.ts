import { describe, it } from 'fino:test/test';
import { readinessTraceSnapshot, currentWorkloadOwner } from 'internal:scheduler-native';
import { timeout } from 'internal:runtime/loop';

describe('Readiness operation tracing', () => {
  it('correlates a live Realm with its parent and current test', async (t) => {
    const owner = currentWorkloadOwner();
    const snapshot = JSON.parse(readinessTraceSnapshot(owner));
    if (!snapshot.enabled) return;
    const realm = snapshot.realms[owner];
    t.ok(realm.parent >= 0, 'Realm identifies its parent');
    t.equal(typeof realm.entry, 'string');
    if (realm.entry === 'internal:test-worker') {
      const test = JSON.parse(realm.observations.test);
      t.equal(new URL(test.specifier).href, import.meta.url);
      t.equal(test.stage, 'running');
      t.ok(test.name.includes('correlates a live Realm'));
    }
    t.ok(snapshot.events.every((event) => event.owner === owner));
  });

  it('follows a timer through routing and resolver consumption', async (t) => {
    const before = JSON.parse(readinessTraceSnapshot(currentWorkloadOwner()));
    const timer = timeout(1);
    const registered = JSON.parse(readinessTraceSnapshot(currentWorkloadOwner())).events.findLast(
      (event) => event.stage === 'registered' && event.sequence > before.sequence,
    );
    await timer;
    const after = JSON.parse(readinessTraceSnapshot(currentWorkloadOwner()));
    if (!after.enabled) {
      t.equal(after.events.length, 0);
      return;
    }
    const events = after.events.filter((event) => event.sequence > before.sequence);
    const consumed = events.find(
      (event) => event.stage === 'resolved' && event.operation === registered?.operation,
    );
    t.ok(consumed, 'destination Realm records actual resolver invocation');
    const chain = after.events.filter((event) => event.operation === consumed?.operation);
    for (const stage of [
      'registered',
      'controller-received',
      'controller-installed',
      'routed',
      'mailbox-drained',
      'resolved',
    ]) {
      t.ok(
        chain.some((event) => event.stage === stage),
        `records ${stage}`,
      );
    }
    t.ok(
      chain.every((event) => event.owner === consumed.owner),
      'stable destination owner',
    );
    t.ok(consumed.operation > 0, 'stable nonzero operation identity');
  });
});

describe('Readiness trace discard evidence', () => {
  it('identifies a completion delivered after its resolver was cancelled', async (t) => {
    const native = await import('internal:scheduler-native');
    const loop = await import('internal:runtime/loop');
    const before = JSON.parse(native.readinessTraceSnapshot(currentWorkloadOwner()));
    const timer = loop.timeout(60_000);
    const registered = JSON.parse(
      native.readinessTraceSnapshot(currentWorkloadOwner()),
    ).events.findLast((event) => event.sequence > before.sequence && event.stage === 'registered');
    timer.cancel();
    if (!before.enabled) {
      t.equal(registered, undefined);
      return;
    }
    t.ok(registered);
    // Inject a late completion deterministically; no timer race is needed.
    native.routeProcessReadiness(
      registered.owner,
      registered.ident,
      registered.filter,
      0,
      0,
      0,
      registered.token,
      0,
      false,
      registered.operation,
    );
    loop.tick(0);
    const events = JSON.parse(native.readinessTraceSnapshot(currentWorkloadOwner())).events.filter(
      (event) => event.operation === registered.operation,
    );
    t.ok(events.some((event) => event.stage === 'mailbox-drained'));
    t.ok(events.some((event) => event.stage === 'operation-no-longer-pending'));
    t.ok(events.some((event) => event.stage === 'discarded-resolver-missing'));
    t.ok(!events.some((event) => event.stage === 'resolved'));
  });
});

describe('Readiness trace generations', () => {
  it('detects an old completion meeting a replacement resolver', async (t) => {
    const native = await import('internal:scheduler-native');
    if (!JSON.parse(native.readinessTraceSnapshot(currentWorkloadOwner())).enabled) {
      t.equal(JSON.parse(native.readinessTraceSnapshot(currentWorkloadOwner())).events.length, 0);
      return;
    }
    const loop = await import('internal:runtime/loop');
    const { dlopen } = await import('fino:ffi');
    const { os } = await import('internal:process');
    const libc = dlopen(os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
      pipe: { parameters: ['buffer'], result: 'i32' },
      close: { parameters: ['i32'], result: 'i32' },
    });
    const fds = new Int32Array(2);
    t.equal(libc.symbols.pipe(fds.buffer), 0);
    try {
      void loop.readable(fds[0]!);
      const original = JSON.parse(
        native.readinessTraceSnapshot(currentWorkloadOwner()),
      ).events.findLast((event) => event.stage === 'registered');
      void loop.readable(fds[0]!);
      const replacement = JSON.parse(
        native.readinessTraceSnapshot(currentWorkloadOwner()),
      ).events.findLast((event) => event.stage === 'registered');
      t.ok(original.operation !== replacement.operation);
      t.equal(original.token, replacement.token);
      native.routeProcessReadiness(
        original.owner,
        original.ident,
        original.filter,
        0,
        0,
        0,
        original.token,
        0,
        false,
        original.operation,
      );
      loop.tick(0);
      const events = JSON.parse(native.readinessTraceSnapshot(currentWorkloadOwner())).events;
      t.ok(
        events.some(
          (event) =>
            event.operation === original.operation &&
            event.stage === 'resolver-generation-mismatch',
        ),
      );
    } finally {
      loop.removeRead(fds[0]!);
      libc.symbols.close(fds[0]!);
      libc.symbols.close(fds[1]!);
    }
  });
});

describe('Readiness trace failure reports', () => {
  it('preserves cross-Realm evidence in a failed parallel test report', async (t) => {
    const { runCli, withTempProject } = await import('../commands/cli-test-helpers.ts');
    await withTempProject(
      {
        'failure.test.ts': [
          "import { test } from 'fino:test/test';",
          "test('record then fail', async (t) => {",
          '  await new Promise((resolve) => setTimeout(resolve, 1));',
          '  t.equal(1, 2);',
          '});',
        ].join('\n'),
      },
      async (dir) => {
        const result = await runCli(['test', '--parallel', 'failure.test.ts'], {
          cwd: dir,
          env: { FINO_TRACE_READINESS: '1' },
        });
        t.equal(result.result.code, 1);
        const marker = '# readiness trace: ';
        const line = result.stdout.split('\n').find((line) => line.startsWith(marker));
        t.ok(line, 'failed suite emits a recording');
        t.ok(
          result.stdout.indexOf(marker) < result.stdout.indexOf('# tests 1'),
          'snapshot is emitted before final suite totals',
        );
        const snapshot = JSON.parse(line!.slice(marker.length));
        t.equal(snapshot.version, 1);
        t.equal(snapshot.enabled, true);
        t.ok(snapshot.events.some((event) => event.stage === 'resolved'));
        t.ok(
          new Set(snapshot.events.map((event) => event.owner)).size > 1,
          'one recording spans isolated owners',
        );
        t.ok(result.stdout.includes('# readiness analysis: '));
      },
    );
  });
});
