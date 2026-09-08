/** Gate a native completion while deliberately withholding its controller watch. */
import * as native from 'internal:scheduler-native';
import { dlopen } from 'fino:ffi';
import { os } from 'internal:process';
const libc = dlopen(os === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
  pipe: { parameters: ['buffer'], result: 'i32' },
  write: { parameters: ['i32', 'buffer', 'usize'], result: 'isize' },
  close: { parameters: ['i32'], result: 'i32' },
});
const fds = new Int32Array(2);
libc.symbols.pipe(fds.buffer);
const child = native.createScheduledRealm(
  '',
  new URL('./native-wake-child.ts', import.meta.url).href,
  [],
  false,
  JSON.stringify(fds[0]),
  undefined,
  false,
);
const snapshot = () => JSON.parse(native.readinessTraceSnapshot(child.owner));
const deadline = Date.now() + 10000;
try {
  while (true) {
    const s = snapshot();
    if (
      s.realms[child.owner]?.phase === 'waiting' &&
      s.nativeWork.active.some(
        (op) => op.owner === child.owner && op.kind === 'ffi' && op.stage === 'running',
      )
    )
      break;
    if (Date.now() > deadline) throw new Error('child never reached gated native read');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  libc.symbols.write(fds[1], new Uint8Array([1]).buffer, 1);
  const deliveryDeadline = Date.now() + 5000;
  while (
    native.takeScheduledRealmStatus(child.handle).kind === 'pending' &&
    Date.now() < deliveryDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const s = snapshot();
  const pending = s.nativeWork.active.filter((op) => op.owner === child.owner);
  const completedDirectly = native.takeScheduledRealmStatus(child.handle).kind === 'done';
  if (!completedDirectly)
    throw new Error('native completion depends on the I/O controller: ' + JSON.stringify(pending));
  console.log('native completion delivered directly');
} finally {
  // Release native work even if setup failed, then restore the old wake path
  // for cleanup so the regression also exits reliably on an unfixed binary.
  libc.symbols.write(fds[1], new Uint8Array([1]).buffer, 1);
  native.registerReactorWake(child.owner, child.wakeFd);
  const cleanupDeadline = Date.now() + 5000;
  while (
    native.takeScheduledRealmStatus(child.handle).kind === 'pending' &&
    Date.now() < cleanupDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  if (native.takeScheduledRealmStatus(child.handle).kind === 'pending')
    native.forceScheduledRealm(child.handle);
  native.closeScheduledRealm(child.handle);
  libc.symbols.close(fds[0]);
  libc.symbols.close(fds[1]);
}
