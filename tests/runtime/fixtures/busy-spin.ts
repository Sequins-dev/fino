/**
 * The realistic greedy workload: module evaluation completes normally, then
 * a timer handler enters a loop that never yields. Handler code runs outside
 * the microtask checkpoint, which is the window where the watchdog is
 * allowed to terminate.
 */
setTimeout(() => {
  for (;;) {
    /* deliberately blocking */
  }
}, 20);
