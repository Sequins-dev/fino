import { dlopen } from 'fino:ffi';

const libc = dlopen('libc.so.6', {
  getpid: {
    parameters: [],
    result: 'i32',
  },
});

export default function sandboxSyncGetpid(): number {
  return Number(libc.symbols.getpid());
}
