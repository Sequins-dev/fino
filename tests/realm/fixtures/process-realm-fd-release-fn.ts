import { dlopen } from 'fino:ffi';
import { os } from 'fino:process';
import { Realm } from 'fino:realm';

const libc = dlopen(os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  fcntl: {
    parameters: ['i32', 'i32', 'i32'],
    result: 'i32',
  },
});
const F_GETFD = 1;

function countOpenFds(): number {
  let open = 0;
  for (let fd = 3; fd < 4096; fd++) {
    if (libc.symbols.fcntl(fd, F_GETFD, 0) >= 0) open++;
  }
  return open;
}

export default async function (): Promise<{ before: number; after: number }> {
  const before = countOpenFds();
  for (let index = 0; index < 12; index++) {
    const realm = new Realm({
      process: true,
      entry: new URL('./process-realm-empty.ts', import.meta.url).pathname,
    });
    await realm.run();
  }
  await new Promise<void>((resolve) => setTimeout(resolve, 20));
  return { before, after: countOpenFds() };
}
