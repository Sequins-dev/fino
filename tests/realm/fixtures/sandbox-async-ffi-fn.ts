import { dlopen } from 'fino:ffi';

const libc = dlopen('libc.so.6', {
  getpid: {
    parameters: [],
    result: 'i32',
    async: true,
  },
});

export default async function sandboxAsyncFfi(): Promise<string> {
  try {
    await libc.symbols.getpid();
    return 'unexpectedly allowed';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
