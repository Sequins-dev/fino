import { dlopen } from 'fino:ffi';
import { os } from 'fino:process';
import { port } from 'fino:realm/self';

const isolateId = Math.random().toString(36).slice(2);
const library = dlopen(os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  usleep: { parameters: ['u32'], result: 'i32', async: true }
});

export default async function asyncFfiCall(delayMicros: number): Promise<string> {
  const pending = library.symbols.usleep(delayMicros) as Promise<number>;
  port?.postMessage({ type: 'ffi-started' });
  await pending;
  return isolateId;
}
