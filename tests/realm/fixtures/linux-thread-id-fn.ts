import { dlopen } from 'fino:ffi';

const libc = dlopen('libc.so.6', {
  gettid: {
    parameters: [],
    result: 'i32',
  },
});

export default function linuxThreadId(): number {
  return Number(libc.symbols.gettid());
}
