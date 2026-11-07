---
description: "Unified local search and explicit scoped memory with authorization, expiry, correction, and deletion."
kind: "package-reference"
---

# @deepseek-ai/dsh-retrieval

English | [中文](README.zh.md)

## Summary

Search workspace evidence and explicitly saved memories through one service. Keep personal memory opt-in and limit returned context by relevance and estimated tokens. Mount an embedding provider and persistent store alongside this service; the optional tools provide agent access.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Enable the [complete native retrieval overlay](../../../docs/user/guide/local-retrieval.md) to mount all required services. The following row configures this package inside that composition.

```yaml
- name: '@deepseek-ai/dsh-retrieval'
  config:
    persistentMemory: false
    crossSessionRead: false
    useAccelerator: false
    portabilityEnabled: false
```

`enabled` controls every operation. `maxTextChars`, `maxTopK`, and `maxPendingWrites` bound inputs, results, and mutation queues. `maxMemories` counts all retained memory records, including expired and superseded records. Memory reads enforce host-resolved principal, workspace, session, and agent ownership before scoring; model arguments cannot select an identity.

`portabilityEnabled: true` admits explicit-memory export and import, and makes forgetting write its ledger entry before deleting. `portabilityDir` must then be an absolute directory outside the repository, and `maxPortabilityRecords` bounds one export. The service refuses to load when portability is enabled without an absolute `portabilityDir`.

See the [configuration catalog](../../../docs/config-catalog.md) for accepted fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`remember` writes explicit facts with attribution and optional expiry. Exact duplicates reuse an existing record. `updateMemory` increments its version; explicit `supersedes` retires older facts. `forget` removes only authorized memory records and verifies absence in the canonical store. Source chunks cannot be deleted through memory operations.

[`portability.ts`](src/portability.ts) defines the export envelope, the forgotten ledger, and the import journal; [`portability-ops.ts`](src/portability-ops.ts) owns their ordering. One version (`MEMORY_EXPORT_VERSION`) is both written and read, and every stored field of a memory travels in fixed order, so a new record field fails to compile until the format accounts for it. An export carries committed records only: pending supersession is rolled forward before the read, and a pending row is refused at decode. Import re-embeds the accepted text into the mounted store's space, stages it under a write-ahead journal keyed by store path, verifies byte-identical readback plus one active and one inactive retrievability probe, then publishes. A failed batch is removed and the original store is never opened for writing; the next import for that store clears an interrupted journal before planning. Admission refuses a ledger-forgotten id, a foreign owner, an id already holding different content, and records past `maxMemories`, and reports each by id with its reason. Inactive rows keep their lifecycle state and never become retrievable. Every operator-named file is resolved one path component at a time with filesystem links followed, so a name that leaves `portabilityDir` through a link is refused before any read or write.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Retrieval group](../README.md) — package selection.
- [Local retrieval guide](../../../docs/user/guide/local-retrieval.md) — setup, recovery, and privacy.
- [Retrieval subsystem](../../../docs/subsystems/retrieval.md) — service ownership.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-retrieval-tools`, which owns tool results and automatic context.

#### KV Cache effect

No direct request tokens or cache changes. Consumer-owned logged results determine context growth.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Memory contradiction detection requires an explicit update or supersession; no model silently rewrites facts.
- A shared local principal is not multi-user authentication. Use separate operating-system accounts and Harness homes.
- Workspace and session indexes are derivatives; explicit memories live in the authoritative store, so back them up before replacing their embedding space, then import an export into the new store.
- Portability moves explicit memories only. Source chunks come from a rebuild of configured files and authorized sessions, and one export stays under `maxPortabilityRecords`.
- The forgotten ledger is state below the current `portabilityDir`. A store backup taken before a deletion, or an import into a different `portabilityDir`, can still reintroduce that fact.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The [memory portability format Agent Note](../../../.agents/notes/implemented/feature/2026-11-02-memory-portability-format.md) records why the ledger entry is written before deletion, why pending rows never travel, and why import re-embeds instead of copying vectors. [portability.spec.ts](tests/portability.spec.ts) checks the format, file paths, and ledger rules; [portability-ops.spec.ts](tests/portability-ops.spec.ts) reaches every ordering branch through a `PortabilityHost` override.

</details>
