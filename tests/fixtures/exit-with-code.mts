/**
 * Fixture: call process.exit() with a non-zero exit code.
 * Used to verify that the exit code propagates correctly to the parent process.
 */
import { exit } from 'fino:process';
exit(42);
