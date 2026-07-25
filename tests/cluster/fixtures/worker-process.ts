import { getCluster, joinCluster, leaveCluster } from 'fino:cluster';
import { argv, stdin } from 'fino:process';
const seed = argv[2];
if (seed === undefined || seed.length === 0) throw new Error('cluster worker fixture: missing seed URL');
await joinCluster({
  seed,
  nodeId: 'cluster-worker',
  tls: { rejectUnauthorized: false }
});
while ((getCluster()?.peers.length ?? 0) === 0) {
  await new Promise((resolve) => setTimeout(resolve, 1));
}
console.log('worker ready');
try {
  for await (const _ of stdin()) {}
} finally {
  leaveCluster();
}
