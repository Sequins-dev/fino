# Cluster Release Contract

The cluster subsystem is release-ready for the current WebSocket transport. A
node joins with `startCluster()` or `joinCluster()`, and `Realm({ remote: true
})` uses the active cluster client to spawn work onto another worker node.

## Release Behavior

- **Heartbeat and membership:** workers send heartbeats every 2500 ms; the seed
  treats a worker as down after 7500 ms without a heartbeat. Transport-level
  disconnects also emit peer-down handling immediately.
- **Spawn routing:** the seed owns spawn routing and selects the eligible worker
  with the lowest reported CPU load, excluding the requester. If no eligible
  worker exists, the spawn rejects with a failure `SPAWN_ACK`.
- **Ownership:** the seed is authoritative for parent and child port ownership.
  `REALM_EXIT`, `TERMINATE`, and `PEER_DOWN` use that registry to settle active
  remote `Realm.run()` and `Realm.call()` waiters instead of leaving parent
  promises pending.
- **Failure propagation:** remote bootstrap errors, call errors, graceful exits,
  explicit `terminate()`, worker loss, and local `leaveCluster()` all settle the
  parent-side realm operation.
- **Shutdown:** `leaveCluster()` is synchronous and idempotent. It stops the
  active worker client and local seed if present; active remote realm users
  should still call `terminate()` or await their operations.

## Deferred Scope

- Direct peer-to-peer `PORT_MSG` remains deferred. Current data-plane messages
  route through the seed; this is acceptable until latency or seed throughput
  requires direct worker connections.
- QUIC transport remains deferred. `ClusterTransport` is already abstracted, and
  WebSocket is the release transport.
- Seed election and cluster authentication remain deferred and should be
  designed together. The current release assumes a single trusted seed.
