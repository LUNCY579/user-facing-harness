# Agent Note: Authoritative local retrieval and rebuildable compression

Status: implemented

English | [中文](2026-11-01-authoritative-local-retrieval.zh.md)

## Problem

Workspace evidence, historical Sessions, and explicit memories have different sources of authority. A compressed similarity index has neither ownership metadata nor the transaction guarantees needed to own them. Adding another persistent copy makes interrupted writes, deletion, and embedding-model changes harder to reconcile on an ordinary laptop.

## Decision

The [native retrieval composition](../../../../packages/retrieval/README.md) keeps Zvec records and vectors authoritative. Files and original Session logs own their source text; their chunks are derivatives. Explicit memories are authoritative Zvec records and cannot be reconstructed from source-index rebuilding.

turbovec runs in one isolated Python worker with bounded stdio messages, queues, vector count, deadlines, and threads. Its four-bit copies are ephemeral. Canonical metadata selects authorized candidates before compressed scoring; missing IDs, protocol errors, or worker loss select Zvec. Rebuilding re-embeds authorized canonical text in its unchanged embedding space.

A memory supersession writes a hidden pending record before changing predecessor metadata and activating the successor. A scoped read repairs interrupted durable intent before admitting current records. A failed commit reports `outcome_pending`; cancellation does not imply that a previous durable write disappeared. Source synchronization uses a separate pending-ID journal and publishes completed sources only after accepted writes.

Principal and original canonical workspace identity come from trusted host configuration and Agent state. Personal memory and historical-session indexing require separate opt-ins. This composition assumes one operator owns its Harness home; it does not authenticate tenants sharing a server.

## Alternatives considered

**A persistent turbovec authority:** it does not supply the metadata filtering or memory lifecycle the service needs. An ephemeral derivative avoids a second crash-recovery and deletion authority.

**A mandatory compressed reranker:** the [measured comparison](../../../../benchmarks/context-retrieval/report/README.md) owns the performance evidence. Extra candidate generation, serialization, and process dispatch do not establish a speedup; Zvec remains the simpler default, and two-bit compression remains experimental.

**Assuming multi-row atomicity:** the Node API can accept a vector upsert before a later scalar update fails. Staged publication and explicit recovery replace that unsupported assumption.

**Automatic conversation-to-personal-memory extraction:** source indexing and explicit memory retention serve different purposes. Personal retention stays opt-in and requires an explicit write operation.

## Consequences

The primary store survives optional-worker failure, and the model receives logged, source-linked evidence through existing tools and request hooks. Compression does not reduce canonical Zvec storage. Synchronous native query/build calls cannot be interrupted mid-call, and a changed embedding space requires a separate index plus the re-embedding import owned by the [memory portability format Agent Note](../feature/2026-11-02-memory-portability-format.md).

Verification covers native persistence, scoped reads and mutations, interrupted publication, worker crashes and process-exit barriers, HTTP cancellation, rebuilds, keyless Loader workflows, and recorded Session replay. The benchmark runs built JavaScript in fresh children and publishes raw measurements; real-model reasoning, neural embedding quality, and other operating systems remain separate verification work.
