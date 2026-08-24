# Realm and Lifecycle Reliability

Use this review whenever work owns async resources, schedules concurrent work, crosses an isolate/process/remote boundary, or exposes capabilities.

## Lifecycle map

Identify the valid states and transitions for creation, start, progress, normal completion, failure, cancellation, close, and termination. For each transition, define:

- the owner and who may initiate it;
- the promises, iterators, waiters, callbacks, or messages that settle;
- resources released and whether repeated cleanup is harmless;
- ordering relative to in-flight work and queued microtasks; and
- recovery or terminal behavior after failure.

Cover cancellation before start, while queued, during active work, after partial output, and during shutdown when those states are reachable. Bound queues and buffers, define backpressure, and state the overload policy.

## Realm matrix

Check scheduled, sandbox, process, and remote modes to the extent the subsystem claims to support them:

| Concern | Questions |
| --- | --- |
| Data | Is every boundary value transferable or explicitly rejected before crossing? |
| Capabilities | Can a child narrow access without any path to re-grant a denied capability? |
| Ordering | Is message, task, and cleanup ordering deterministic within the documented contract? |
| Ownership | Does resource ownership survive moves, disconnection, crashes, and parent shutdown? |
| Failure | How do child errors, transport loss, process exit, and remote unavailability surface? |
| Observability | Can important transitions and resource use be inspected consistently? |
| Difference | Is every unavoidable mode difference explicit, documented, and tested? |

Never depend on isolate-thread affinity or process-global per-Realm state. Make time, randomness, I/O, environment, and external services injectable where doing so enables repeatable behavior. Production and simulated implementations should remain behind the same contract.
