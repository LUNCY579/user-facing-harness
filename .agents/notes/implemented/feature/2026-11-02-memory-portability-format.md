# Agent Note: Authorized memory portability and embedding-space migration

Status: implemented

English | [中文](2026-11-02-memory-portability-format.zh.md)

## Problem

Explicit memories are authoritative records in the native store, so replacing the embedding provider, model, endpoint, weight revision, normalization, or dimension cannot restore them the way a source-index rebuild restores chunks. An operator facing that change previously had no path except hand-editing store contents. Hand editing risks the three failures that matter here: reviving a fact the operator already forgot, promoting an expired or superseded row back into retrieval, and claiming an ownership record the receiving host never granted. Export also has to survive an interruption, because a half-written population is worse than no export.

## Decision

The [portability format](../../../../packages/retrieval/retrieval/src/portability.ts) and its [ordering](../../../../packages/retrieval/retrieval/src/portability-ops.ts) carry committed memories as one versioned envelope: format version, export time, the source embedding space, and every stored field of each record in fixed declaration order, including ownership keys, scope, attribution, version, supersession links, timestamps, expiry, content digest, and space key. Adding a record field without a format decision fails to compile. `MEMORY_EXPORT_VERSION` is both written and read, and a reader rejects any other version instead of guessing.

Decode validates the envelope against facts the engine itself writes: a text must hash to its recorded digest, an ownership combination the engine never writes is refused, and a `pending` row is refused because only its own store can resolve an unfinished supersession. Export resolves pending supersession for the caller first, so no export carries a half-written lifecycle. Ownership travels unchanged; a record whose owner the receiving identity may not write is refused and reported by id.

Forgetting appends the record id and content digest to the forgotten ledger before deleting, and refuses to delete while the ledger is unwritable. Import reads that ledger and refuses a known-forgotten id until the operator deliberately removes the entry. Inactive rows keep their expiry and supersession state, so an import cannot make a retired fact retrievable.

Import re-embeds accepted text into the mounted store's current space instead of transporting vectors, stages the batch under a write-ahead journal named by the target store path, verifies that every record reads back byte-identical with a vector in the target space, probes one active record as retrievable and one inactive record as not, then publishes. A failed write or verification removes exactly the staged ids and keeps the journal when removal cannot be proven, so the next import for that store cleans up before it plans again. The source store is never opened for writing, which keeps its backup valid.

Two operator-run commands reach this path through the existing identity resolver, and both are registered only while `retrieval.config.portabilityEnabled` is true. Files stay below an absolute `portabilityDir` the operator chooses, a name that leaves it through traversal or a filesystem link is refused before any read or write, and the whole subsystem defaults off.

## Alternatives considered

**Copy the stored vectors:** a vector is meaningful only in the space that produced it, so copying one across a model, dimension, or normalization change silently mixes spaces. Re-embedding treats stored text as authoritative and proves the target space through the same verification every import runs.

**Expose export and import as model tools:** either call moves an entire population of personal facts, which should be one deliberate human decision rather than something reachable from a prompt. Tools would also add schema to every request while the capability stays off by default.

**Rewrite ownership on import so any store accepts any export:** the record text plus its scope is what the authorization protects. Rewriting it would let a hostile envelope claim another workspace's facts as its own, so admission refuses instead of adapting.

**Record every created id, not only forgotten ones:** an id ledger that grows with each memory turns retention into a second authority with no bounded purpose. The negative record is the only entry that changes later behavior, so the ledger carries removals.

**Delete first, then write the ledger:** an interruption between the two would leave the id absent from the store and absent from the ledger, so a later import of an older export would silently restore a forgotten fact. Writing first fails in the safe direction: an extra refusal the operator can inspect.

**Migrate automatically when the embedding space changes at load:** that rewrites authoritative records as a side effect of starting the application, with no chosen target store and no operator confirmation. The service instead refuses the mismatched space and leaves migration to a command.

## Consequences

Portability buys a supported path across embedding spaces, a per-store interrupt-safe staging protocol, and one visible refusal reason per rejected record. It costs two more durable files the operator must back up with the store, and a per-directory guarantee: the forgotten ledger lives below the current `portabilityDir`, so a store backup taken before a deletion, or an import pointed at a different directory, can still reintroduce that fact. Exports are plaintext memory text, so `portabilityDir` stays outside the repository and the files stay operator-protected. Migration is bounded by `maxPortabilityRecords` and one re-embedding pass over the accepted texts.

Verification lives in [portability.spec.ts](../../../../packages/retrieval/retrieval/tests/portability.spec.ts) for format, paths, and ledger rules; [portability-ops.spec.ts](../../../../packages/retrieval/retrieval/tests/portability-ops.spec.ts) for round trips, authorization, cancellation, fault-injected rollback, and interrupted-journal cleanup; and [the command tests](../../../../packages/retrieval/retrieval-tools/tests/portability.spec.ts) for registration, argument parsing, path escape, and a legacy-space import against the native store. Cross-machine restore and multi-operator import remain unverified. The store-authority decision is [authoritative local retrieval](../architecture/2026-11-01-authoritative-local-retrieval.md).
