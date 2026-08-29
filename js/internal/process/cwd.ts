/**
 * internal:process/cwd — Realm-local working-directory state.
 *
 * Public and private aliases of `fino:process` can instantiate the source
 * module separately. This canonical internal module owns one cwd value for the
 * Realm so every alias observes the same state without mutating the host
 * process cwd shared by other Realms.
 *
 * @internal
 */
import { dlopen } from 'fino:ffi';
import { os } from 'internal:process';
import { decodeUtf8, encodeUtf8 } from 'internal:encoding';

const LIBC = os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const lib = dlopen(LIBC, {
  getcwd: {
    parameters: ['buffer', 'usize'],
    result: 'pointer',
  },
  realpath: {
    parameters: ['buffer', 'buffer'],
    result: 'pointer',
  },
  opendir: {
    parameters: ['buffer'],
    result: 'pointer',
  },
  closedir: {
    parameters: ['pointer'],
    result: 'i32',
  },
});

function cstr(value: string): ArrayBuffer {
  const bytes = encodeUtf8(value);
  const buffer = new Uint8Array(bytes.byteLength + 1);
  buffer.set(bytes);
  return buffer.buffer;
}

function decodeBuffer(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const end = bytes.indexOf(0);
  return decodeUtf8(bytes.subarray(0, end === -1 ? bytes.byteLength : end));
}

function hostCwd(): string {
  const buffer = new ArrayBuffer(4096);
  if (lib.symbols.getcwd(buffer, 4096) === null) throw new Error('getcwd failed');
  return decodeBuffer(buffer);
}

let currentWorkingDirectory = hostCwd();

/** Return this Realm's current working directory. @internal */
export function getRealmCwd(): string {
  return currentWorkingDirectory;
}

/** Resolve, validate, and install this Realm's current working directory. @internal */
export function setRealmCwd(path: string): void {
  const requested = String(path);
  if (requested.includes('\0')) throw new Error(`chdir('${requested}') failed`);
  const candidate = requested.startsWith('/')
    ? requested
    : `${currentWorkingDirectory}/${requested}`;
  const resolved = new ArrayBuffer(4096);
  if (lib.symbols.realpath(cstr(candidate), resolved) === null) {
    throw new Error(`chdir('${requested}') failed`);
  }
  const canonical = decodeBuffer(resolved);
  const directory = lib.symbols.opendir(cstr(canonical));
  if (directory === null) throw new Error(`chdir('${requested}') failed`);
  lib.symbols.closedir(directory);
  currentWorkingDirectory = canonical;
}
