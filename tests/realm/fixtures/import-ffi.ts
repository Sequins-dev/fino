/**
 * Fixture: child realm that attempts to import a blocked module.
 * Throws if the import unexpectedly succeeds (regression guard).
 */
class _ImportFfiSentinel extends Error {}
try {
  await import('fino:ffi');
  throw new _ImportFfiSentinel('fino:ffi was accessible but should have been blocked');
} catch (e) {
  if (e instanceof _ImportFfiSentinel) throw e;
  // Otherwise the import was blocked as expected — exit cleanly.
}
