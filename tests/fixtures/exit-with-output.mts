/**
 * Fixture: write text to stdout then call process.exit(0).
 * Used to verify that exit() flushes the stdout coalesce buffer before exiting
 * so the output is not silently lost.
 */
import { stdout, exit } from 'fino:runtime/process';

// Write without a trailing newline to ensure the coalesce buffer is not empty.
const w = stdout();
await w.write(new TextEncoder().encode('exit-flush-test-output'));
exit(0);
