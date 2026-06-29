/**
 * Fixture: tries to import fino:ffi and writes a message to parent based on success/failure.
 * Used to verify that import rules (including `from` clause) are evaluated per-importer.
 */
let imported = false;
try {
  await import('fino:ffi');
  imported = true;
} catch { /* blocked */ }

// Export result for call() mode
export default function () { return imported; }
