/**
 * Simulation descriptor boundary. No operation falls back to the host.
 *
 * High-level world adapters (for example FakeFs) do not require descriptors.
 * A simulator that admits descriptor APIs replaces internal:io with its own
 * Realm-local implementation. Bootstrap observations use fixed virtual values;
 * other effects fail at the operation, not merely at module import time.
 *
 * @internal
 */
type Direct = typeof import('internal:io');
import { os, arch } from 'internal:process';

/** Virtual process metadata; no ambient arguments, environment, or executable path. */
export const processInfo = { os, arch, args: [], env: {}, execPath: '' };

function unavailable(operation: string): never {
  throw new Error(`fino:sim — ${operation} is unavailable in a simulation`);
}

function denied<T>(family: string): T {
  const symbols = new Proxy(Object.create(null), {
    get(target, name) {
      if (Object.hasOwn(target, name)) return target[name];
      return () => unavailable(`${family}.${String(name)}`);
    },
  });
  return { symbols } as T;
}

export const file = denied<Direct['file']>('file');
export const watch = denied<Direct['watch']>('watch');
export const stream = denied<Direct['stream']>('stream');
export const socket = denied<Direct['socket']>('socket');
export const terminal = denied<Direct['terminal']>('terminal');
export const terminalMode = denied<Direct['terminalMode']>('terminal mode');
export const capture = denied<Direct['capture']>('output capture');
export const security = denied<Direct['security']>('OS policy');
export const securityErrno = null;
export const spawn = denied<Direct['spawn']>('spawn');
export const pipe2Lib = null;
export const spawnChdirLib = null;
export const spawnInheritLib = null;
export const spawnCloseFromLib = null;
export const process = denied<Direct['process']>('process');
Object.assign(process.symbols, { getpid: () => 1, getppid: () => 0 });
// Explicit bootstrap values, not observations of the host process.
export const output = {
  symbols: {
    getpid: () => 1,
    sysconf: () => 1,
    write: () => unavailable('output.write'),
    printf: () => unavailable('output.printf'),
  },
} as unknown as Direct['output'];
export const cwd = {
  symbols: {
    getcwd(buffer: ArrayBuffer) {
      new Uint8Array(buffer).set([47, 0]);
      return buffer;
    },
    realpath: () => unavailable('cwd.realpath'),
    opendir: () => unavailable('cwd.opendir'),
    closedir: () => unavailable('cwd.closedir'),
  },
} as unknown as Direct['cwd'];
export const tls = new Proxy(Object.create(null), {
  get(_target, name) {
    return () => unavailable(`tls.${String(name)}`);
  },
}) as Direct['tls'];
export const networkInterfaces: Direct['networkInterfaces'] = () =>
  unavailable('networkInterfaces');
