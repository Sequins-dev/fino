/** Direct file operations for the Realm I/O provider. @internal */
import { dlopen } from 'fino:ffi';
import { os } from 'internal:process';
const isDarwin = os === 'darwin';
const LIBC = isDarwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const errnoFn = isDarwin ? '__error' : '__errno_location';
export const file = dlopen(LIBC, {
  open: {
    parameters: ['buffer', 'i32', 'i32'],
    result: 'i32',
  },
  close: {
    parameters: ['i32'],
    result: 'i32',
  },
  stat: {
    parameters: ['buffer', 'buffer'],
    result: 'i32',
  },
  lstat: {
    parameters: ['buffer', 'buffer'],
    result: 'i32',
  },
  fstat: {
    parameters: ['i32', 'buffer'],
    result: 'i32',
  },
  opendir: {
    parameters: ['buffer'],
    result: 'pointer',
  },
  readdir: {
    parameters: ['pointer'],
    result: 'pointer',
  },
  closedir: {
    parameters: ['pointer'],
    result: 'i32',
  },
  mkdir: {
    parameters: ['buffer', 'u32'],
    result: 'i32',
  },
  rmdir: {
    parameters: ['buffer'],
    result: 'i32',
  },
  unlink: {
    parameters: ['buffer'],
    result: 'i32',
  },
  rename: {
    parameters: ['buffer', 'buffer'],
    result: 'i32',
  },
  readlink: {
    parameters: ['buffer', 'buffer', 'usize'],
    result: 'isize',
  },
  symlink: {
    parameters: ['buffer', 'buffer'],
    result: 'i32',
  },
  realpath: {
    parameters: ['buffer', 'buffer'],
    result: 'pointer',
  },
  fchmod: {
    parameters: ['i32', 'u32'],
    result: 'i32',
  },
  read: {
    parameters: ['i32', 'buffer', 'usize'],
    result: 'isize',
  },
  write: {
    parameters: ['i32', 'buffer', 'usize'],
    result: 'isize',
  },
  lseek: {
    parameters: ['i32', 'i64', 'i32'],
    result: 'i64',
  },
  pread: {
    parameters: ['i32', 'buffer', 'usize', 'i64'],
    result: 'isize',
  },
  pwrite: {
    parameters: ['i32', 'buffer', 'usize', 'i64'],
    result: 'isize',
  },
  fsync: {
    parameters: ['i32'],
    result: 'i32',
  },
  ftruncate: {
    parameters: ['i32', 'i64'],
    result: 'i32',
  },
  flock: {
    parameters: ['i32', 'i32'],
    result: 'i32',
  },
  [errnoFn]: {
    parameters: [],
    result: 'pointer',
  },
  chmod: {
    parameters: ['buffer', 'u32'],
    result: 'i32',
  },
  chown: {
    parameters: ['buffer', 'i32', 'i32'],
    result: 'i32',
  },
  lchown: {
    parameters: ['buffer', 'i32', 'i32'],
    result: 'i32',
  },
  utimes: {
    parameters: ['buffer', 'buffer'],
    result: 'i32',
  },
  truncate: {
    parameters: ['buffer', 'i64'],
    result: 'i32',
  },
  link: {
    parameters: ['buffer', 'buffer'],
    result: 'i32',
  },
  access: {
    parameters: ['buffer', 'i32'],
    result: 'i32',
  },
});
