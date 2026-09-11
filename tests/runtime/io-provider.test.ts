import { describe, it } from 'fino:test/test';
import * as scheduler from 'internal:scheduler-native';
import * as loop from 'internal:runtime/loop';
import { Realm, ImportMap } from 'fino:realm';

describe('Realm-local I/O providers', () => {
  it('rolls back handles when a provider refuses readiness', async (t) => {
    using realm = new Realm({
      entry: 'internal:provider-rejection-probe',
      overrides: ImportMap.inherit([
        {
          pattern: 'internal:runtime/readiness',
          directive: {
            type: 'source',
            code: "export * from 'internal:sim/readiness';",
            source_map: '',
          },
        },
        {
          pattern: 'internal:provider-rejection-probe',
          directive: {
            type: 'source',
            code: `
          import * as loop from 'internal:runtime/loop';
          export default async function () {
            const before = loop._activeHandleCounts();
            let refused = 0;
            const pending = [
              () => loop.readable(987654), () => loop.writable(987654),
              () => loop.timeout(1000), () => loop.proc(987654),
              () => loop.vnode(987654, 0, () => {}), () => loop.signal(15, () => {}),
            ].map(async (request) => {
              try { await request(); } catch { refused++; }
            });
            // Sample in the same turn: the control transport independently
            // re-arms its own read watch when this async handler yields.
            const after = loop._activeHandleCounts();
            await Promise.all(pending);
            return { before, after, refused };
          }
        `,
            source_map: '',
          },
        },
      ]),
    });
    const result = await realm.call();
    t.equal(result.refused, 6);
    for (const field of ['reads', 'writes', 'timers', 'procs', 'vnodes', 'pendingInstalls']) {
      t.equal(result.after[field], result.before[field], `${field} is not leaked`);
    }
  });
  it('keeps byte ownership out of the readiness host', (t) => {
    t.equal('submitOwnedIo' in scheduler, false, 'host has no byte-submission interface');
    t.equal('takeOwnedIo' in scheduler, false, 'host has no byte-completion interface');
    t.equal('readOwned' in loop, false, 'readiness loop does not own read buffers');
    t.ok(scheduler.currentWorkloadOwner() > 0, 'application executes on the reactor pool');
  });
  it('replaces descriptor operations and readiness inside a movable Realm', async (t) => {
    const io = `
      export { file } from 'internal:io/file';
      export { watch } from 'internal:io/watch';
      export { socket } from 'internal:io/socket';
      export { cwd } from 'internal:io/cwd';
      export { process, pipe2Lib } from 'internal:io/process';
      export * as processInfo from 'internal:process';
      export { spawn, spawnChdirLib, spawnInheritLib, spawnCloseFromLib } from 'internal:io/spawn';
      export { terminalMode } from 'internal:io/terminalMode';
      export { capture } from 'internal:io/capture';
      export { security, securityErrno } from 'internal:io/security';
      export * as tls from 'internal:openssl';
      export { networkInterfaces } from 'internal:net-native';
      export const calls = [];
      export const output = { symbols: {
        write(fd, bytes, length) { calls.push(['output', fd, ...bytes]); return length; },
        getpid() { return 1; }, sysconf() { return 1; },
      }};
      export const terminal = { symbols: { isatty() { return 1; } } };
      export const stream = { symbols: {
        fcntl(fd) { calls.push(['flags', fd]); return 0; },
        fstat(fd) { calls.push(['stat', fd]); return -1; },
        read(fd, buffer, length) {
          calls.push(['read', fd, length]);
          buffer.set([4, 5]); return 2;
        },
        write(fd, buffer, length) {
          calls.push(['write', fd, ...buffer]); return length;
        },
      }};
    `;
    const readiness = `
      import * as native from 'internal:scheduler-native';
      export const usesProcessReadiness = () => true;
      export const requests = [];
      let events = [];
      export function registerProcessReadiness(fd, filter, flags, fflags, data, token) {
        if (fd !== 987654) throw new Error('Unexpected application readiness: ' + fd);
        requests.push([filter, flags]);
        if (!(flags & 2)) {
          events.push(fd, filter, 0, 0, 2, token, 0, 0);
          native.signalReactorOwner(native.currentWorkloadOwner());
        }
        return 0;
      }
      export function takeSharedLoopEvents(owner) {
        const batch = Float64Array.from(events);
        events = []; return batch;
      }
    `;
    const entry = `
      import { FdReader, FdWriter } from 'fino:stream';
      import { calls } from 'internal:io';
      import { requests } from 'internal:runtime/readiness';
      import { writeBytes } from 'internal:runtime/libc';
      import { isatty } from 'fino:tty';
      export default async function () {
        const reader = new FdReader(987654, () => {});
        const writer = new FdWriter(987654, () => {});
        const buffer = new Uint8Array([9, 9, 9, 9]);
        const result = await reader.readInto(buffer.subarray(1, 3));
        await writer.write(new Uint8Array([7, 8]));
        await writer.flush();
        await reader.close(); await writer.close();
        const outputCount = writeBytes(987654, new Uint8Array([1, 2, 3]));
        return { buffer: [...buffer], count: result.value, outputCount, terminal: isatty(987654), calls, requests };
      }
    `;
    using realm = new Realm({
      entry: 'app:io-probe',
      overrides: ImportMap.inherit([
        { pattern: 'internal:io', directive: { type: 'source', code: io, source_map: '' } },
        {
          pattern: 'internal:runtime/readiness',
          directive: { type: 'source', code: readiness, source_map: '' },
        },
        { pattern: 'app:io-probe', directive: { type: 'source', code: entry, source_map: '' } },
      ]),
    });
    const result = (await realm.call()) as {
      buffer: number[];
      count: number;
      outputCount: number;
      terminal: boolean;
      calls: [string, ...number[]][];
      requests: [number, number][];
    };
    t.deepEqual(result.buffer, [9, 4, 5, 9], 'readInto preserves the caller view boundaries');
    t.equal(result.count, 2);
    t.equal(result.outputCount, 3, 'diagnostic output uses the same provider');
    t.equal(result.terminal, true, 'terminal observations use the provider');
    t.ok(result.calls.some((call) => call[0] === 'read' && call[1] === 987654));
    t.ok(result.calls.some((call) => call[0] === 'write' && call[2] === 7 && call[3] === 8));
    t.ok(result.requests.some(([filter, flags]) => filter === -1 && (flags & 2) === 0));
    t.ok(result.requests.some(([filter, flags]) => filter === -1 && (flags & 2) !== 0));
  });
});
