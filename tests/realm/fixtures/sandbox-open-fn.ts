import { dlopen } from 'fino:ffi';

const libc = dlopen('libc.so.6', {
  open: {
    parameters: ['buffer', 'i32', 'i32'],
    result: 'i32',
    variadic: 2,
  },
  close: {
    parameters: ['i32'],
    result: 'i32',
  },
});

export default function sandboxOpen(path: string): number {
  const encoded = new TextEncoder().encode(path);
  const cPath = new Uint8Array(encoded.length + 1);
  cPath.set(encoded);
  const fd = Number(libc.symbols.open(cPath, 0, 0));
  if (fd >= 0) libc.symbols.close(fd);
  return fd;
}
