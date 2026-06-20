# cluster

fino:cluster - public API for cluster participation.

A node joins the cluster in one of two roles:

`startCluster({ port })` - Start a seed server on the given port AND
  participate as a worker. The calling node becomes both the coordinator
  and an execution target. This is the entry point for the first node.

`joinCluster({ seed })` - Connect to an existing seed node. The calling
  node becomes a worker: it accepts realm spawns and hosts them locally.
  It can also spawn remote realms onto other workers.

After either call, `new Realm({ ..., remote: true })` routes through the
active cluster client to spawn onto a remote worker.

Only one cluster connection per process is supported. Calling either
function when already connected throws.

Current release scope uses the WebSocket transport with one trusted seed
node. Seed election and cluster authentication are not implemented in this
release. Direct peer-to-peer `PORT_MSG` delivery and QUIC transport remain
deferred; control-plane and data-plane messages continue to route through
the seed-backed WebSocket cluster.

```ts
import { startCluster, leaveCluster } from 'fino:cluster';
import { Realm } from 'fino:realm';

await startCluster({ port: 9999, nodeId: 'seed-a' });
const realm = new Realm({ entry: './worker.mts', remote: true });
await realm.call('healthcheck');
leaveCluster();
```

## StartClusterOptions

```ts
interface StartClusterOptions {
```

Options for starting the first cluster seed node.

```ts
import { startCluster, type StartClusterOptions } from 'fino:cluster';

const opts: StartClusterOptions = { port: 9999, nodeId: 'seed-a' };
await startCluster(opts);
```

### port

```ts
port: number
```

TCP port the seed WebSocket server will listen on.

The port must be available on the local host. There is no default because
the first cluster node must advertise a stable address to workers.

```ts
import { startCluster } from 'fino:cluster';

await startCluster({ port: 9999 });
```

### nodeId

```ts
nodeId?: string
```

Optional node identifier.

When omitted, the seed uses `seed-{port}`. Choose a stable ID if logs or
cluster diagnostics need to correlate restarts.

```ts
import { startCluster } from 'fino:cluster';

await startCluster({ port: 9999, nodeId: 'primary-seed' });
```

## JoinClusterOptions

```ts
interface JoinClusterOptions {
```

Options for joining an existing cluster seed.

```ts
import { joinCluster, type JoinClusterOptions } from 'fino:cluster';

const opts: JoinClusterOptions = { seed: 'ws://127.0.0.1:9999' };
await joinCluster(opts);
```

### seed

```ts
seed: string
```

WebSocket URL of the seed node.

The URL must include the `ws://` scheme and a reachable host and port. The
call fails if the connection cannot be established.

```ts
import { joinCluster } from 'fino:cluster';

await joinCluster({ seed: 'ws://seed.example.test:9999' });
```

### nodeId

```ts
nodeId?: string
```

Optional worker node identifier.

When omitted, a short random `worker-*` ID is generated. Provide a stable
value for predictable logs or cluster placement diagnostics.

```ts
import { joinCluster } from 'fino:cluster';

await joinCluster({ seed: 'ws://127.0.0.1:9999', nodeId: 'worker-a' });
```

## startCluster

```ts
async function startCluster(opts: StartClusterOptions): Promise<void>
```

Start the cluster seed server and participate as a worker on this node.

The seed is the control-plane hub: it routes SPAWN requests, tracks realm
ownership, and propagates deaths. It does NOT relay data-plane messages in
steady state.

This call returns immediately after the seed starts listening. The event
loop keeps the server alive as long as there are connected peers.

Throws if this process is already connected to a cluster. The function
resolves with `void` after the seed transport is listening and the local
worker client has connected to it.

```ts
import { startCluster, leaveCluster } from 'fino:cluster';

await startCluster({ port: 9999, nodeId: 'seed-a' });
leaveCluster();
```

## joinCluster

```ts
async function joinCluster(opts: JoinClusterOptions): Promise<void>
```

Connect to an existing seed and register this node as a worker.

After this call the node accepts remote realm spawns and can spawn realms
onto other nodes in the cluster.

Throws if this process is already connected or if the seed URL cannot be
reached. The returned promise resolves once the worker transport is
connected and the client loop has started.

```ts
import { joinCluster, leaveCluster } from 'fino:cluster';

await joinCluster({ seed: 'ws://127.0.0.1:9999', nodeId: 'worker-a' });
leaveCluster();
```

## leaveCluster

```ts
function leaveCluster(): void
```

Disconnect from the cluster. Active remote realms are not terminated.

The call is synchronous and idempotent. It stops the active worker client and
seed server, if present, then clears module-level cluster state. Remote
realm users should terminate or await their realms separately.

```ts
import { startCluster, leaveCluster } from 'fino:cluster';

await startCluster({ port: 9999 });
leaveCluster();
```
