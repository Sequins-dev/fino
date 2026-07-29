/**
 * Return the Linux CPU currently executing the sandbox Realm thread.
 */
import { dlopen } from 'fino:ffi';

const libc = dlopen('libc.so.6', {
  sched_getcpu: {
    parameters: [],
    result: 'i32',
  },
});

export default function linuxCpuId(): number {
  return Number(libc.symbols.sched_getcpu());
}
