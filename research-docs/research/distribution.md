# Distribution — Deferred Remote Pool Design

## Status

The original design (`RealmPoolServer`, `pool.addRemote()`, `NetPort`) was
written before cluster Realms existed.  It is now obsolete.

The cluster already provides `new Realm({ remote: true })` for spawning onto
a remote node. `RealmPool` remains a local thread-realm pool for this release;
it does not dispatch across cluster nodes.

Remote pool scheduling is deferred until a separate distributed-pool design can
answer placement, discovery, timeout, and authentication policy questions. Until
then, applications should use `Realm({ remote: true })` for remote placement and
`RealmPool` for local warm-worker throughput.

## Design questions before any code

**Q1. Pool-vs-cluster shape.**  
Should `RealmPool` gain a "remote slot" mode that uses cluster spawn under
the hood (`new Realm({ thread: true })` vs `new Realm({ remote: true })`)?
Or is distributed dispatch a separate top-level abstraction built on top of
the cluster, not on top of `RealmPool`?

**Q2. Worker discovery.**  
How does a pool find cluster nodes willing to host workers?  Options: a
static address list, DNS-SD, or the seed broadcasting available capacity.

**Q3. Slow-worker handling.**  
The current per-call timeout terminates a worker.  For remote workers,
killing the node may be too blunt.  What is the right policy — backpressure,
circuit-breaking, or replacement?

**Q4. Authentication.**  
Remote pool connections are inter-process.  Should they reuse the cluster
auth mechanism (Q3 in `cluster.md`), or have their own token/mTLS model?

Do not start implementation without a design pass that answers at least Q1
and Q2.
