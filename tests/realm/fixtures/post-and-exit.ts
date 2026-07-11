/** Posts one final message and then lets the Realm exit. */
import { port } from 'fino:realm/self';

if (port === undefined) throw new Error('post-and-exit: expected a realm port');
port.postMessage('final-message');
