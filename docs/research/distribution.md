# Distribution — Remaining Work

## Remote Workers

`RealmPool` for local thread workers is implemented. Remote distribution is not:

- **RealmPoolServer**: Server that hosts remote Realm workers and routes messages via WebSockets, enabling `pool.addRemote(url)` to dispatch work to workers on other machines.
- **NetPort Integration**: The transport connecting a local `RealmPool` to a remote `RealmPoolServer`. Needs to integrate with the existing wake-pipe + mpsc channel pattern used by thread Realms.

## Advanced Routing

- **Content-Based Routing**: Routing based on message content (e.g. tenant ID, request type) to enable sticky sessions or specialized worker pools.
- **Dynamic Topology**: Ability to update the routing table at runtime for hot-swapping worker code without dropping in-flight requests.

## Open Questions

- **Q-DIST-1**: Should `pool.addRemote()` authenticate the connection? If so, what mechanism (token, mTLS)?
- **Q-DIST-3**: How to handle persistently slow workers beyond simple per-call timeouts? Options: backpressure signalling, worker replacement, circuit breaking.
- **Q-DIST-5**: Should the pool support priority queues for different traffic classes?
