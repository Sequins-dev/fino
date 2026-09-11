/** Direct socket operations for the Realm I/O provider. @internal */
import { dlopen, type NativeSymbolMap } from 'fino:ffi';
import { os } from 'internal:process';
const isDarwin = os === 'darwin';
const isLinux = os === 'linux';
const LIBC = isDarwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6';
const errnoFn = isDarwin ? '__error' : '__errno_location';
const _defs = {
  socket: {
    parameters: ['i32', 'i32', 'i32'],
    result: 'i32',
  },
  bind: {
    parameters: ['i32', 'buffer', 'u32'],
    result: 'i32',
  },
  getsockname: {
    parameters: ['i32', 'buffer', 'buffer'],
    result: 'i32',
  },
  connect: {
    parameters: ['i32', 'buffer', 'u32'],
    result: 'i32',
  },
  listen: {
    parameters: ['i32', 'i32'],
    result: 'i32',
  },
  accept: {
    parameters: ['i32', 'buffer', 'buffer'],
    result: 'i32',
  },
  send: {
    parameters: ['i32', 'buffer', 'usize', 'i32'],
    result: 'isize',
  },
  recv: {
    parameters: ['i32', 'buffer', 'usize', 'i32'],
    result: 'isize',
  },
  sendto: {
    parameters: ['i32', 'buffer', 'usize', 'i32', 'buffer', 'u32'],
    result: 'isize',
  },
  recvfrom: {
    parameters: ['i32', 'buffer', 'usize', 'i32', 'buffer', 'buffer'],
    result: 'isize',
  },
  sendmsg: {
    parameters: ['i32', 'buffer', 'i32'],
    result: 'isize',
  },
  recvmsg: {
    parameters: ['i32', 'buffer', 'i32'],
    result: 'isize',
  },
  setsockopt: {
    parameters: ['i32', 'i32', 'i32', 'buffer', 'u32'],
    result: 'i32',
  },
  getsockopt: {
    parameters: ['i32', 'i32', 'i32', 'buffer', 'buffer'],
    result: 'i32',
  },
  shutdown: {
    parameters: ['i32', 'i32'],
    result: 'i32',
  },
  close: {
    parameters: ['i32'],
    result: 'i32',
  },
  unlink: {
    parameters: ['buffer'],
    result: 'i32',
  },
  fcntl: {
    parameters: ['i32', 'i32', 'i32'],
    result: 'i32',
    variadic: 2,
  },
  inet_pton: {
    parameters: ['i32', 'buffer', 'buffer'],
    result: 'i32',
  },
  inet_ntop: {
    parameters: ['i32', 'buffer', 'buffer', 'u32'],
    result: 'pointer',
  },
  if_nameindex: {
    parameters: [],
    result: 'pointer',
  },
  if_freenameindex: {
    parameters: ['pointer'],
    result: 'void',
  },
  if_nametoindex: {
    parameters: ['buffer'],
    result: 'u32',
  },
  [errnoFn]: {
    parameters: [],
    result: 'pointer',
  },
} as const satisfies NativeSymbolMap;
// Optional symbols are loaded only on platforms that provide them.
export const socket = dlopen(LIBC, {
  ..._defs,
  ...(isLinux
    ? ({
        accept4: { parameters: ['i32', 'buffer', 'buffer', 'i32'], result: 'i32' },
        sendmmsg: { parameters: ['i32', 'buffer', 'u32', 'i32'], result: 'i32' },
        recvmmsg: { parameters: ['i32', 'buffer', 'u32', 'i32', 'buffer'], result: 'i32' },
      } as const)
    : {}),
  ...(isDarwin
    ? ({
        sendmsg_x: { parameters: ['i32', 'buffer', 'u32', 'i32'], result: 'i32' },
        recvmsg_x: { parameters: ['i32', 'buffer', 'u32', 'i32'], result: 'i32' },
      } as const)
    : {}),
});
