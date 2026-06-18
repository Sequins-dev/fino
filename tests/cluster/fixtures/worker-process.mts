import { getCluster, joinCluster, leaveCluster } from 'fino:cluster';
import { argv, stdin } from 'fino:process';
import * as loop from 'internal:runtime/loop';

const port = Number(argv[2]);
if (!Number.isFinite(port) || port <= 0) {
  throw new Error('cluster worker fixture: missing seed port');
}

await joinCluster({ seed: `ws://127.0.0.1:${port}`, nodeId: 'cluster-worker' });
while ((getCluster()?.peers.length ?? 0) === 0) {
  await loop.timeout(1);
}
console.log('worker ready');

try {
  for await (const _ of stdin()) {
    // Wait until the parent closes stdin.
  }
} finally {
  leaveCluster();
}
