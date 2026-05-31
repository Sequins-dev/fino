# Cluster — Remaining Work

The core cluster implementation is complete: import rule system, Facade RPC
(scalar, read-streams, write-streams, handles), process realms, cluster
realms, seed routing, structured concurrency across nodes.

---

## Deferred items

### 1. Direct peer-to-peer PORT_MSG

Currently all PORT_MSG traffic is routed through the seed.  The plan is for
nodes to open direct WebSocket connections to each other after `PEER_UP` and
route PORT_MSG without touching the seed.  This removes the seed as a
bottleneck and SPOF for the data plane.

Trigger: when data-plane latency or seed throughput becomes a concern.

### 2. QUIC transport

`ClusterTransport` already abstracts the protocol.  `WebSocketTransport` is
the only implementation today.  A `QuicTransport` would slot in without
changing anything above the transport layer.

The RPC wire format was designed with QUIC in mind:

| Envelope | QUIC mapping |
|---|---|
| `__rpc_req` / `__rpc_res` | request message + response message |
| `__rpc_chunk` / `__rpc_end` / `__rpc_err` | server-initiated unidirectional stream |
| `__rpc_send_start` / `__rpc_send_chunk` / `__rpc_send_end` / `__rpc_send_err` | client-initiated unidirectional stream |

Trigger: when WebSocket latency/overhead is a bottleneck for high-throughput
inter-Realm messaging.

### 3. Seed election and cluster auth

Single seed is acceptable for now.  When needed, tackle election and
authentication (mTLS or token-based) together.

Deferred until both are ready to design as a unit.
