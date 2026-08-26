import { dlopen } from 'fino:ffi';
import { os } from 'fino:process';

const libc = dlopen(os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  fcntl: {
    parameters: ['i32', 'i32', 'i32'],
    result: 'i32',
  },
});

const F_GETFD = 1;
let open = 0;
for (let fd = 3; fd < 4096; fd++) {
  if (libc.symbols.fcntl(fd, F_GETFD, 0) >= 0) open++;
}
console.log(open);
