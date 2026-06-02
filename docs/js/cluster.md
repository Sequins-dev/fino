# cluster

fino:cluster — public API for cluster participation.

A node joins the cluster in one of two roles:

`startCluster({ port })` — Start a seed server on the given port AND
  participate as a worker. The calling node becomes both the coordinator
  and an execution target. This is the entry point for the first node.

`joinCluster({ seed })` — Connect to an existing seed node. The calling
  node becomes a worker: it accepts realm spawns and hosts them locally.
  It can also spawn remote realms onto other workers.

After either call, `new Realm({ ..., remote: true })` routes through the
active cluster client to spawn onto a remote worker.

Only one cluster connection per process is supported. Calling either
function when already connected throws.

## StartClusterOptions

```ts
interface StartClusterOptions {
```

Options for starting the first cluster seed node.

### port

```ts
port: number
```

TCP port the seed WebSocket server will listen on.

### nodeId

```ts
nodeId?: string
```

Node identifier. Defaults to `seed-{port}`.

## JoinClusterOptions

```ts
interface JoinClusterOptions {
```

Options for joining an existing cluster seed.

### seed

```ts
seed: string
```

WebSocket URL of the seed node, e.g. `ws://host:9999`.

### nodeId

```ts
nodeId?: string
```

Node identifier. Defaults to a random string.

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

## joinCluster

```ts
async function joinCluster(opts: JoinClusterOptions): Promise<void>
```

Connect to an existing seed and register this node as a worker.

After this call the node accepts remote realm spawns and can spawn realms
onto other nodes in the cluster.

## leaveCluster

```ts
function leaveCluster(): void
```

Disconnect from the cluster. Active remote realms are not terminated.
