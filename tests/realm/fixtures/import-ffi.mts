/**
 * Fixture: child realm that attempts to import a blocked module.
 * The import should throw; we catch the error and exit cleanly.
 */
try {
  await import('fino:ffi');
  console.error('ERROR: blocked import should have thrown');
} catch (_e) {
  // Expected — fino:ffi is blocked in this realm.
}
