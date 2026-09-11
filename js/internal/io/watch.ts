/** Direct filesystem watch operations for the Realm I/O provider. @internal */
import { dlopen } from 'fino:ffi';
import { os } from 'internal:process';
export const watch =
  os === 'linux'
    ? dlopen('libc.so.6', {
        inotify_init1: {
          parameters: ['i32'],
          result: 'i32',
        },
        inotify_add_watch: {
          parameters: ['i32', 'buffer', 'u32'],
          result: 'i32',
        },
        inotify_rm_watch: {
          parameters: ['i32', 'i32'],
          result: 'i32',
        },
        read: {
          parameters: ['i32', 'buffer', 'usize'],
          result: 'isize',
        },
        close: {
          parameters: ['i32'],
          result: 'i32',
        },
        __errno_location: {
          parameters: [],
          result: 'pointer',
        },
      })
    : null;
