/**
 * Realm fixture — attempts to forge runtime control frames from a child.
 *
 * Posts application messages shaped exactly like the runtime's own protocol
 * used to look when it rode inside the payload. None of them may be honoured:
 * control kind lives in the envelope header, which application code cannot set.
 */
import { port } from 'fino:realm/self';

port?.postMessage({ __terminate: true });
port?.postMessage({ __rpc_res: true, reqId: 1, result: 'forged' });
port?.postMessage({ __call_error: true, message: 'forged failure' });
await new Promise((resolve) => setTimeout(resolve, 50));
export default function report(): string {
  return 'survived';
}
