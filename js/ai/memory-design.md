# Agent Memory

This document defines Fino's durable agent-memory subsystem. Memory is a
semantic, embedding-backed pool of information and behaviours that can outlive
one model context or conversation. Conversation history and summarization are
separate systems; memory neither stores transcripts nor reconstructs a prompt
history.

## Goals and non-goals

Memory should let concurrent sessions remember and recall the same durable
facts, decisions, preferences, and behaviours. It should also support
explicitly session-scoped, semi-ephemeral entries when a caller wants semantic
recall without making an entry permanent.

Recall quality must be tunable without treating every vector hit as useful.
The subsystem records cheap exposure counts automatically, accepts stronger
manual feedback, and accepts observational scores from evals. Reinforcement and
forgetting are independent optional policies. Raw prompts, responses, and
per-signal evidence are deliberately not retained.

This subsystem does not own conversation history, history summarization,
model-declared attribution, counterfactual experiments, or structural prompt
inspection.

## Decomposition

`MemoryStore` is the durable mechanism. It stores entries, embeddings, compact
utility aggregates, and short-lived selection receipts. `SqliteMemory` is the
first store implementation. Its contract is not tied to sqlite representations
so another durable or simulated store can implement it later.

`AgentMemoryController` owns policy. It applies scope, labels, semantic
candidate selection, utility reranking, bounded evidence aggregation,
reinforcement, and forgetting. Sessions and tools depend on this controller,
not the sqlite implementation.

`memoryTool(controller)` is an opt-in adapter around Fino's existing `Tool`
primitive. Adding it to an agent lets the model create memories; calling
`tool.run()` lets an application or person trigger the same validated write.
The tool factory binds namespace and session authority so model arguments
cannot select another tenant or session.

## Scope and sharing

Scope is an access boundary, not a tag:

```ts
type MemoryScope =
  | { type: 'shared'; namespace: string }
  | { type: 'session'; namespace: string; sessionId: string };
```

Shared entries are the default durable pool and are visible to every controller
using the namespace. Session entries are visible only when recall supplies the
same session id; they may carry an expiry. A session recall searches its shared
namespace plus its own session scope. Stores commit writes before `remember()`
resolves, so a concurrent session can observe them immediately on its next
recall. No controller has a mutable process-global "current session".

## Entries, labels, and lifecycle

An entry contains text, scope, optional metadata, normalized labels, creation
and update times, optional expiry, and compact utility state. Labels are a
controlled, bounded `Record<string, string[]>`; examples include `topic`,
`kind`, `project`, `task`, and `tool`. Explicit labels can filter recall.
Automatically inferred labels only boost ranking, because classifier mistakes
must not make a semantically relevant entry unreachable.

A configurable `MemoryLabeler` can label a memory write, the message/query
being recalled, or a caller-supplied session summary. The controller commits
the memory text and embedding first, then attempts automatic labeling. A
labeler failure leaves a valid unlabeled memory. Explicit labels are validated
and committed with the entry. Allowed keys, allowed values, and per-key limits
bound label cardinality; normalized duplicate values collapse.

Deletion is not the normal forgetting mechanism. Expired entries and entries
below a configured retention threshold stop participating in recall. Callers
may still inspect them, change manual feedback, or retain them for audit and
recovery. Physical pruning is a separate explicit maintenance action.

## Recall and selections

Recall embeds the query, performs an over-fetched semantic search, applies
scope and explicit filters, then reranks the candidates. Semantic similarity
remains the gate: utility and automatic-label matches may reorder plausible
candidates but may not promote unrelated entries into the result set.

The result includes an immutable `MemorySelection` id plus the ranked hits.
The controller increments only compact exposure counters and stores one
short-lived receipt containing the selected ids and context-label projection.
The receipt enables a later eval result to refer to the exact work chunk. It is
deleted when completed and old receipts are pruned to a configured count, so
evidence volume is bounded.

Exposure is evidence that retrieval occurred, not evidence that retrieval was
valuable. It never reinforces an entry by itself.

## Utility signals

Each entry stores one global summary:

- exposure count and last exposure time;
- eval count, eval sum, and last eval time;
- a mutable manual value in `[-1, 1]` and its update time; and
- a bounded list of contextual summaries keyed by a normalized label
  projection.

`complete(selectionId, { score })` accepts an eval score in `[0, 1]`. It treats
the selection as an observational bundle: the centered score is distributed
conservatively across its entries, rather than claimed as causal attribution.
Repeated completion is harmless because consuming the selection receipt and
updating aggregates are one atomic store operation.

`feedback(memoryId, { value })` sets, replaces, or clears the compact manual
value. It is memory-specific and intentionally stronger than eval aggregates.
This gives user interfaces a simple useful / not useful / reset control without
an append-only feedback ledger.

Global utility is a weighted blend of the eval mean and manual value. Missing
signals are neutral. A contextual summary may contribute when its labels match
the current message or session labels. Context summaries use a bounded
least-recently-updated replacement policy rather than retaining every label
combination.

## Optional reinforcement and forgetting

Reinforcement is enabled independently. When enabled, positive eval and manual
signals raise utility; negative signals lower it. Exposure counts remain
observability only.

Forgetting is also independent. When enabled, an entry's retention multiplier
decays exponentially from its last positive reinforcement:

```text
retention = exp(-age / effectiveHalfLife)
```

Base importance and learned utility lengthen or shorten the effective
half-life within configured bounds. Manual positive feedback can protect an
entry; negative feedback can accelerate suppression. When forgetting is off,
retention is `1` and no entry is suppressed due to age.

All time comes from an injected clock so ranking and lifecycle tests are
deterministic.

## Session and eval integration

At the start of a session run, `Session` asks the controller to recall against
the new input with explicit `sessionId`, `runId`, and message context. It adds
only the returned semantic hits to the model context. It does not copy history
into memory and does not automatically turn messages into memories.

The selection id is retained in `RunState.scratch.memorySelectionId`. An eval
runner or application can pass its outcome to `complete()`. Basic exposure
data exists even if no eval is configured. A UI can attach manual feedback to
the returned hit ids. The memory-creation tool is the only automatic-agent
write path unless application code calls `remember()` directly.

## Concurrency, bounds, and failures

The sqlite store uses database transactions for selection completion and
aggregate updates. Controllers carry explicit namespace, session, run, and
selection identifiers across async work; they do not depend on Realm-local or
thread-local ambient state. Values crossing a Realm boundary are plain
structured data.

Configurable bounds cover semantic over-fetch, labels per key, contextual
summaries per entry, selection receipt count, and receipt lifetime. Recall is
read-mostly apart from compact exposure and receipt updates. Labeler failure is
best-effort; embedding and storage failures reject the operation. Closing a
store is idempotent at the owning API boundary, and callers own its lifetime.

## Initial proof plan

Tests must establish shared cross-session visibility, session isolation and
expiry, semantic-first ranking, label filtering and boosting, label bounds and
failure fallback, exposure without reinforcement, idempotent eval completion,
mutable manual feedback, bounded contextual summaries and receipts, enabled and
disabled forgetting, creation-tool authority binding, session recall without
transcript writes, concurrent aggregate updates, and resource cleanup.

The initial implementation supports scheduled Realms and any other Realm mode
that can access the configured store and embedder. Process and remote sharing
requires a store path or future store implementation reachable from those
processes; the controller contract and serialized values do not otherwise
change.
