/**
 * Keep a sandbox Realm in synchronous JavaScript until V8 is force-terminated.
 */
export default function sandboxBusyLoop(): never {
  while (true) {
    // Deliberately non-yielding noisy-neighbor workload.
  }
}
