import { dlopen } from 'fino:ffi';
import { startProfiling, stopProfiling } from 'fino:profiler';

const libc = dlopen('libc.so.6', {
  sigemptyset: { parameters: ['buffer'], result: 'i32' },
  sigaddset: { parameters: ['buffer', 'i32'], result: 'i32' },
  pthread_sigmask: { parameters: ['i32', 'buffer', 'buffer'], result: 'i32' },
  raise: { parameters: ['i32'], result: 'i32' },
});
const mask = new ArrayBuffer(128);
const previous = new ArrayBuffer(128);
libc.symbols.sigemptyset(mask);
libc.symbols.sigaddset(mask, 27); // Linux SIGPROF
startProfiling('pending-sample');
libc.symbols.pthread_sigmask(0, mask, previous); // SIG_BLOCK
libc.symbols.raise(27);
stopProfiling('pending-sample');
// Deliver a sample that was already pending when the last profiler stopped.
libc.symbols.pthread_sigmask(2, previous, mask); // SIG_SETMASK
console.log('survived pending profiler signal');
