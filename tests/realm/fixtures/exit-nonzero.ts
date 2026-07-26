/**
 * Fixture: exits with code 1 to simulate a crashed/failed child process.
 */
import { exit } from 'fino:process';
exit(1);
