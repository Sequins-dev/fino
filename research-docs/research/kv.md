# Cluster KV And Distributed Services

> Status: roadmap note. This replaces the node-local KV idea extracted from
> the retired `stdlib-dx.md`. `fino:cache` remains the local cache surface;
> `fino:kv` should be a distributed, multi-tenant runtime service built on the
> cluster and orchestrator work in `multi-tenant-runtime.md`.

## 1. Goal

Add a first-class distributed key-value service for cluster-wide runtime state,
tenant/app state, and coordination-adjacent workflows that need more than a
process-local cache.

The KV service should be the first concrete example of a broader cluster-wide
service model:

- each node's orchestrator main thread can host runtime services;
- services communicate over a cluster service RPC/event protocol;
- services can persist local state, replicate state, and react to peer
  join/leave/resync events;
- application realms access services through explicit capability grants.

`fino:kv` should not be a Redis clone and should not hide distributed-system
tradeoffs. Its default shape should favor local durable reads/writes with
asynchronous replication and configurable write confirmation.

## 2. Relationship To `fino:cache`

`fino:cache` is already the local application cache abstraction: memory/SQLite,
TTL, namespaces, tag invalidation, and HTTP/AI cache helpers. Keep that surface
node-local and cache-oriented.

`fino:kv` is the distributed runtime service:

- `fino:cache` optimizes repeated local work and can lose entries.
- `fino:kv` stores replicated bytes/metadata with tenant/app namespace
  isolation.
- Cache middleware can later use KV as an optional backend, but that should be
  explicit because distributed cache invalidation and write-confirmation
  policies are application decisions.

## 3. Use Cases

Distributed KV should support:

- multi-tenant app namespaces with small replicated state;
- feature flags, config, and policy snapshots distributed to all nodes;
- service registry records and routing metadata;
- replicated session or nonce records where callers want failover;
- rate-limit counters when local-only counters are insufficient;
- watchable runtime state for control-plane dashboards;
- durable backing for higher-level coordination services.

It should not be the only coordination primitive. Leases, locks, service
ownership, and deployment desired state need stricter semantics than
eventually consistent cache-style writes. Those services can share the same
orchestrator service framework and may use KV as storage, but they should expose
their own correctness contracts.

## 4. Service Architecture

### Orchestrator Service Registry

Extend the existing orchestrator service registry into a cluster-visible service
model:

- local services register with a name, version, and capability requirements;
- the cluster client advertises available local services after join and during
  reconnect;
- the seed/orchestrator tracks service availability alongside membership;
- clients can send service RPC requests without creating a remote realm;
- services can subscribe to peer events to resync replicated state.

This should be independent from realm `PORT_MSG` routing. Realm messaging is an
application data plane; service RPC is the runtime control/service plane.

### Service Protocol

Add cluster message shapes for service traffic:

```ts
type ClusterMessage =
  | ExistingClusterMessages
  | {
      t: 'SERVICE_REQ';
      requestId: string;
      service: string;
      op: string;
      payload: string;
    }
  | {
      t: 'SERVICE_RES';
      requestId: string;
      ok: boolean;
      payload?: string;
      error?: string;
    }
  | {
      t: 'SERVICE_EVENT';
      service: string;
      event: string;
      payload: string;
    };
```

The payload can start as JSON or the runtime serializer's byte format. Keep the
transport wrapper narrow so it can move to CBOR/binary later without changing
service contracts.

### Placement

KV v1 should use replicated-all placement:

- every cluster node that enables KV keeps a local durable replica;
- writes are accepted on the local node and replicated outward;
- reads default to the local replica;
- reconnect and node restart trigger a resync against peers.

Do not start with sharding. Sharded owners need the service placement and
deployment controller from `multi-tenant-runtime.md`; replicated-all is simpler
and matches the cache/config/control-plane use cases.

## 5. Public API Shape

Prefer a small bytes-first store with an ergonomic wrapper:

```ts
import { Kv } from 'fino:kv';

const kv = await Kv.open({
  namespace: {
    tenant: 'acme',
    app: 'billing',
    name: 'sessions'
  },
  durability: 'local',
  replication: {
    mode: 'eventual',
    minReplicas: 1,
    timeoutMs: 500
  }
});

const result = await kv.set('user:42', { name: 'Ada' }, {
  ttlMs: 60_000,
  ifRevision: 'optional-known-revision'
});

const entry = await kv.get<{ name: string }>('user:42');
await kv.delete('user:42', { ifRevision: result.revision });
```

Candidate types:

```ts
interface KvNamespace {
  tenant: string;
  app: string;
  name: string;
}

interface KvOpenOptions {
  namespace: KvNamespace;
  durability?: 'memory' | 'local';
  replication?: {
    mode: 'none' | 'eventual';
    minReplicas?: number;
    timeoutMs?: number;
  };
}

interface KvSetOptions {
  ttlMs?: number;
  expiresAt?: number;
  ifRevision?: string;
}

interface KvWriteResult {
  revision: string;
  durableReplicas: number;
}

interface KvEntry<T = Uint8Array> {
  key: string;
  value: T;
  revision: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
  originNodeId: string;
}
```

Required operations:

- `get(key)`;
- `set(key, value, options?)`;
- `delete(key, options?)`;
- `list({ prefix?, cursor?, limit? })`;
- `watch({ prefix? })`;
- `compareAndSet` or `set(..., { ifRevision })`;
- `close()`.

The low-level store should store `Uint8Array`; the wrapper can support JSON,
strings, and bytes explicitly.

## 6. Semantics

### Namespaces And Capability Grants

Namespaces are not cosmetic prefixes. They are the isolation boundary for
multi-tenant runtime state.

- Namespace identity includes tenant, app, and logical name.
- A realm must be granted access to a namespace or namespace pattern.
- Grant modes should distinguish read, write, watch, and admin/delete.
- Key and namespace length limits should be explicit.
- Many app namespaces are expected; APIs and storage schemas should not assume
  a small fixed namespace count.

### Local Durability And Replication

Write flow:

1. validate namespace/key/grant;
2. assign a monotonic revision for this node;
3. persist the operation to the local durable log/store;
4. apply it to the local materialized view;
5. replicate the operation to peers;
6. resolve the write once the namespace write concern is met.

Single-node clusters can resolve after local durability. Multi-node clusters
should support `minReplicas` so callers can require at least N additional
durable acknowledgements before a write is confirmed.

### Eventual Consistency

The default distributed contract is eventually consistent:

- local reads are fast and read the local materialized view;
- confirmed writes have met their write concern but may not be visible on every
  node immediately;
- peer reconnect triggers missing-operation sync;
- callers that need conflict detection use revisions/CAS;
- services that need strict coordination should use a dedicated lease/lock
  service rather than assuming KV write order is global.

The `fino:security/session` store contract is stricter than this default. A
production authentication-session adapter requires per-key linearizable
conditional writes and read-after-write behavior so logout or ID regeneration
cannot be undone by an in-flight stale request. Do not offer that adapter over
the eventual replicated-all mode. It must wait for an explicit stronger KV
consistency mode or a dedicated session service; holding a distributed lock
for the duration of an HTTP request is not an acceptable substitute.

### Conflict Resolution

Every mutation should carry enough metadata to converge deterministically:

- namespace;
- key;
- operation id;
- revision;
- origin node id;
- logical timestamp or hybrid logical clock value;
- created/updated/expires metadata;
- tombstone marker for deletes.

For normal `set`/`delete`, last-writer-wins by ordered revision metadata is
acceptable. For correctness-sensitive callers, `ifRevision` rejects stale writes
instead of resolving conflicts silently.

### TTLs

TTL metadata replicates with the write:

- `ttlMs` stores an absolute `expiresAt` timestamp;
- reads must not return expired entries;
- expiry should emit a replicated tombstone or deterministic expiry operation;
- pruning can remove old tombstones only after a safe retention window.

## 7. Storage Model

Use SQLite as the first durable replica backend. Keep an append-only operation
log separate from the materialized key view so resync and conflict handling do
not depend on scanning only current values.

Candidate tables:

```sql
CREATE TABLE IF NOT EXISTS fino_kv_ops (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  op_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  origin_node_id TEXT NOT NULL,
  op TEXT NOT NULL,
  value BLOB,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  received_at INTEGER NOT NULL,
  PRIMARY KEY(namespace, op_id)
);

CREATE TABLE IF NOT EXISTS fino_kv_entries (
  namespace TEXT NOT NULL,
  key TEXT NOT NULL,
  revision TEXT NOT NULL,
  origin_node_id TEXT NOT NULL,
  value BLOB NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY(namespace, key)
);

CREATE INDEX IF NOT EXISTS idx_fino_kv_entries_prefix
  ON fino_kv_entries(namespace, key);

CREATE INDEX IF NOT EXISTS idx_fino_kv_entries_expires
  ON fino_kv_entries(namespace, expires_at)
  WHERE expires_at IS NOT NULL;
```

The SQL schema can encode namespace as one stable string derived from
`KvNamespace`, but the public API should keep the structured tenant/app/name
shape.

## 8. Testing Plan

Service protocol:

- service request/response routing does not require a remote realm;
- unknown services and failed handlers return structured errors;
- service events reach subscribed peers;
- reconnect re-advertises local services.

KV behavior:

- namespace grants isolate tenant/app data;
- local durable write is immediately readable on the writer node;
- replicated write becomes readable on another node;
- `minReplicas` succeeds only after enough durable acknowledgements;
- write confirmation rejects or times out when the replica requirement cannot
  be met;
- concurrent writes converge to the same value on all nodes;
- stale `ifRevision` writes reject;
- delete tombstones replicate and suppress older values;
- TTL expiry converges across nodes;
- restart reloads local SQLite state and resyncs missing operations.

Cluster integration:

- single-node cluster works with replication disabled or no peers;
- multi-node cluster continues to serve local reads during peer loss;
- peer reconnect catches up without duplicating operations;
- leaving the cluster closes service clients cleanly.

## 9. Implementation Sequence

1. Add internal cluster service RPC/event messages and in-memory test transport
   coverage.
2. Extend the orchestrator service registry so services can register locally
   and be exposed to the active cluster client.
3. Implement a local durable KV service with SQLite operation log and
   materialized view.
4. Add replicated-all service events, durable acknowledgements, and
   `minReplicas` write concern.
5. Add the public `fino:kv` wrapper with structured namespaces, grants,
   serialization helpers, revisions, TTL, list, and watch.
6. Add reconnect/resync and restart recovery tests.
7. Only after this is stable, revisit sharding or seed-assisted placement for
   high-cardinality app data.

## 10. Non-Goals For V1

- Redis protocol compatibility.
- Sharded key ownership.
- Raft or seed election.
- Global linearizable reads.
- Large blob/object storage.
- Querying by value.
- Treating `fino:cache` as distributed by default.
