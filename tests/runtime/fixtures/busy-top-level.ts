/**
 * A runaway at module top level. Module evaluation is the one window where
 * the watchdog must not terminate — V8's async-module resume cannot survive
 * it — so this stays advisory. Finite, so the test can tear down.
 */
const end = Date.now() + 6_000;
while (Date.now() < end) {
  /* deliberately blocking */
}
