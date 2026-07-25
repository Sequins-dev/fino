import { describe, it } from 'fino:test/test';
import * as loop from 'internal:runtime/loop';
import * as socket from 'fino:net/socket';
import { Isolate } from 'internal:scheduler/isolate';
import { runPooledResidentReadinessWorkloads, runReadinessWorkload, runResidentReadinessWorkload, runSharedResidentReadinessWorkloads } from 'internal:scheduler/readiness';
const ENTRY = new URL('./fixtures/readiness-workload.ts', import.meta.url).pathname;
function connectedPair(): {
  server: number;
  client: number;
  peer: number;
} {
  const server = socket.socket(socket.AF_INET, socket.SOCK_STREAM, 0);
  socket.setsockopt(server, socket.SOL_SOCKET, socket.SO_REUSEADDR, true);
  socket.bind(server, {
    family: 'ipv4',
    ip: '127.0.0.1',
    port: 0
  });
  socket.listen(server, 4);
  socket.setNonblocking(server);
  const address = socket.getsockname(server);
  if (address.family !== 'ipv4') throw new Error('expected IPv4 address');
  const client = socket.socket(socket.AF_INET, socket.SOCK_STREAM, 0);
  socket.setNonblocking(client);
  socket.connect(client, address);
  loop.spin(loop.readable(server));
  const accepted = socket.accept(server);
  if (accepted === null) throw new Error('accept returned null');
  socket.setNonblocking(accepted.fd);
  loop.spin(loop.writable(client));
  return {
    server,
    client,
    peer: accepted.fd
  };
}
function closeAll(...fds: number[]): void {
  for (const fd of fds) {
    try {
      socket.close(fd);
    } catch {}
  }
}
describe('readiness-only isolate scheduler', () => {
  it('shares one host loop while reads stay inside each workload', async (t) => {
    const first = connectedPair();
    const second = connectedPair();
    try {
      const firstResult = runReadinessWorkload(ENTRY, { fd: first.peer });
      const secondResult = runReadinessWorkload(ENTRY, { fd: second.peer });
      t.equal(loop._activeHandleCounts().reads, 2, 'both isolates register on the host loop');
      socket.send(first.client, new TextEncoder().encode('first'));
      socket.send(second.client, new TextEncoder().encode('second'));
      const [a, b] = await Promise.all([firstResult, secondResult]);
      t.equal(a, 'first', 'first isolate performed its own read');
      t.equal(b, 'second', 'second isolate performed its own read');
      t.equal(loop._activeHandleCounts().reads, 0, 'host readiness registrations drained');
    } finally {
      closeAll(first.peer, first.client, first.server);
      closeAll(second.peer, second.client, second.server);
    }
  });
  it('keeps write buffers and retry loops inside the workload', async (t) => {
    const pair = connectedPair();
    try {
      socket.setsockopt(pair.client, socket.SOL_SOCKET, socket.SO_SNDBUF, 4096);
      const fill = new Uint8Array(65536);
      let filled = 0;
      while (true) {
        const written = socket.send(pair.client, fill);
        if (written === socket.EAGAIN) break;
        if (written < 0) throw new Error(`failed to fill socket: ${written}`);
        filled += written;
      }
      t.ok(filled > 0, 'socket send buffer was filled');
      const result = runReadinessWorkload<number>(ENTRY, {
        fd: pair.client,
        write: 'tail'
      });
      while (true) {
        const chunk = socket.recv(pair.peer, 65536);
        if (chunk === socket.EAGAIN || chunk === null) break;
      }
      const written = await Promise.race([result, new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('scheduled write did not resume')), 1e3);
      })]);
      t.equal(written, 4, 'workload completed its own buffered write');
      t.equal(loop._activeHandleCounts().writes, 0, 'host writability registration drained');
    } finally {
      closeAll(pair.peer, pair.client, pair.server);
    }
  });
  it('resumes on the first of several readiness signals', async (t) => {
    const first = connectedPair();
    const neverReady = connectedPair();
    try {
      const result = runReadinessWorkload<string>(ENTRY, {
        fd: first.peer,
        raceFd: neverReady.peer
      });
      t.equal(loop._activeHandleCounts().reads, 2, 'both raced reads registered on the host loop');
      socket.send(first.client, new TextEncoder().encode('winner'));
      const winner = await Promise.race([result, new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('readiness race waited for every fd')), 1e3);
      })]);
      t.equal(winner, 'winner', 'first ready fd resumed the workload');
      t.equal(loop._activeHandleCounts().reads, 0, 'losing readiness watch was cancelled');
    } finally {
      closeAll(first.peer, first.client, first.server);
      closeAll(neverReady.peer, neverReady.client, neverReady.server);
    }
  });
  it('keeps a sole workload entered across repeated readiness cycles', (t) => {
    const pair = connectedPair();
    try {
      const iterations = 64;
      const bytes = new Uint8Array(iterations);
      bytes.fill(1);
      t.equal(socket.send(pair.client, bytes), iterations, 'queued every benchmark byte');
      const result = runResidentReadinessWorkload<number>(ENTRY, {
        fd: pair.peer,
        readIterations: iterations
      });
      t.equal(result.value, iterations, 'workload performed every read');
      t.equal(result.isolateEntries, 1, 'workload was entered once for the run');
      t.equal(result.isolateExits, 1, 'workload was exited once after settlement');
      t.ok(result.loopTurns >= iterations, 'each readiness cycle drove the workload loop');
    } finally {
      closeAll(pair.peer, pair.client, pair.server);
    }
  });
  it('uses structured clone values at the resident isolate boundary', (t) => {
    const result = runResidentReadinessWorkload<bigint>(ENTRY, { structuredValue: 42n });
    t.equal(result.value, 42n, 'BigInt crosses the isolate boundary without JSON');
    t.throws(() => runResidentReadinessWorkload(ENTRY, { structuredValue: () => undefined }), /structured-cloneable/, 'non-cloneable inputs fail at the boundary');
  });
  it('shares one backend across resident workload isolates', (t) => {
    const first = connectedPair();
    const second = connectedPair();
    const firstIsolate = new Isolate(ENTRY, true);
    const secondIsolate = new Isolate(ENTRY, true);
    try {
      socket.send(first.client, new TextEncoder().encode('first'));
      socket.send(second.client, new TextEncoder().encode('second'));
      const a = firstIsolate.runResident<{
        value: string;
        loopFd: number;
      }>({
        fd: first.peer,
        includeLoopFd: true
      });
      const b = secondIsolate.runResident<{
        value: string;
        loopFd: number;
      }>({
        fd: second.peer,
        includeLoopFd: true
      });
      t.equal(a.value.value, 'first', 'first isolate performed its own read');
      t.equal(b.value.value, 'second', 'second isolate performed its own read');
      t.equal(a.value.loopFd, b.value.loopFd, 'both isolates used one kernel backend');
      t.equal(a.isolateEntries + b.isolateEntries, 2, 'each workload was entered once');
      t.equal(a.isolateExits + b.isolateExits, 2, 'each workload exited once after settling');
    } finally {
      firstIsolate.terminate();
      secondIsolate.terminate();
      closeAll(first.peer, first.client, first.server);
      closeAll(second.peer, second.client, second.server);
    }
  });
  it('routes shared-backend readiness to its source isolate', (t) => {
    const first = connectedPair();
    const second = connectedPair();
    try {
      socket.send(first.client, new TextEncoder().encode('first'));
      socket.send(second.client, new TextEncoder().encode('second'));
      const result = runSharedResidentReadinessWorkloads<{
        value: string;
        loopFd: number;
      }>(ENTRY, [{
        fd: first.peer,
        includeLoopFd: true
      }, {
        fd: second.peer,
        includeLoopFd: true
      }]);
      t.equal(result.values[0]?.value, 'first', 'first readiness returned to the first isolate');
      t.equal(result.values[1]?.value, 'second', 'second readiness returned to the second isolate');
      t.equal(result.values[0]?.loopFd, result.values[1]?.loopFd, 'both tasks used the shared backend');
      t.ok(result.workloadSwitches > 0, 'foreign readiness caused a direct workload switch');
      t.equal(result.schedulerReadinessTurns, 0, 'scheduler TypeScript did not process readiness');
    } finally {
      closeAll(first.peer, first.client, first.server);
      closeAll(second.peer, second.client, second.server);
    }
  });
  it('does not leave and re-enter a sole shared-backend workload', (t) => {
    const pair = connectedPair();
    try {
      socket.send(pair.client, new Uint8Array([1]));
      const result = runSharedResidentReadinessWorkloads<number>(ENTRY, [{
        fd: pair.peer,
        readIterations: 1
      }]);
      t.equal(result.values[0], 1, 'the workload performed its read');
      t.equal(result.isolateEntries, 1, 'the sole workload stayed entered');
      t.equal(result.isolateExits, 1, 'the sole workload exited after settlement');
    } finally {
      closeAll(pair.peer, pair.client, pair.server);
    }
  });
  it('keeps the selected pooled workload entered while it remains highest priority', (t) => {
    const pair = connectedPair();
    try {
      const iterations = 64;
      const bytes = new Uint8Array(iterations);
      bytes.fill(1);
      t.equal(socket.send(pair.client, bytes), iterations, 'queued every readiness byte');
      const result = runPooledResidentReadinessWorkloads<number>(ENTRY, [{
        fd: pair.peer,
        readIterations: iterations
      }], {
        threads: 2
      });
      t.equal(result.values[0], iterations, 'the pooled workload performed every read');
      t.equal(result.workloadSwitches, 0, 'no competitor displaced the selected workload');
      t.equal(result.isolateEntries, 1, 'the selected isolate stayed entered');
      t.equal(result.isolateExits, 1, 'the selected isolate exited only after settlement');
    } finally {
      closeAll(pair.peer, pair.client, pair.server);
    }
  });
  it('moves parked workloads between available pool threads', (t) => {
    const pairs = Array.from({
      length: 6
    }, connectedPair);
    try {
      const iterations = 32;
      const bytes = new Uint8Array(iterations);
      bytes.fill(1);
      for (const pair of pairs) {
        t.equal(socket.send(pair.client, bytes), iterations, 'queued every workload byte');
      }
      const result = runPooledResidentReadinessWorkloads<number>(ENTRY, pairs.map((pair) => ({
        fd: pair.peer,
        readIterations: iterations
      })), {
        threads: 2
      });
      t.ok(result.values.every((value) => value === iterations), 'every workload completed');
      t.equal(result.workerThreads, 2, 'the requested worker pool was used');
      t.ok(result.workloadSwitches > 0, 'higher-priority parked work displaced resident isolates');
      t.ok(result.workloadMigrations > 0, 'at least one parked isolate resumed on another worker');
      t.equal(result.isolateEntries, result.isolateExits, 'every cross-thread entry was paired with an exit');
    } finally {
      for (const pair of pairs) closeAll(pair.peer, pair.client, pair.server);
    }
  });
  it('does not steal later thread-local readiness registrations', (t) => {
    const pooled = connectedPair();
    const resident = connectedPair();
    try {
      t.equal(socket.send(pooled.client, new Uint8Array([1])), 1);
      t.equal(runPooledResidentReadinessWorkloads<number>(ENTRY, [{
        fd: pooled.peer,
        readIterations: 1
      }], {
        threads: 1
      }).values[0], 1);
      t.equal(socket.send(resident.client, new Uint8Array([1])), 1);
      t.equal(runResidentReadinessWorkload<number>(ENTRY, {
        fd: resident.peer,
        readIterations: 1
      }).value, 1, 'the thread-local reactor retained its own registration');
    } finally {
      closeAll(pooled.peer, pooled.client, pooled.server);
      closeAll(resident.peer, resident.client, resident.server);
    }
  });
});
