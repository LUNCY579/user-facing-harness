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
```

`enabled` controls every operation. `maxTextChars`, `maxTopK`, and `maxPendingWrites` bound inputs, results, and mutation queues. `maxMemories` counts all retained memory records, including expired and superseded records. Memory reads enforce host-resolved principal, workspace, session, and agent ownership before scoring; model arguments cannot select an identity.

See the [configuration catalog](../../../docs/config-catalog.md) for accepted fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`remember` writes explicit facts with attribution and optional expiry. Exact duplicates reuse an existing record. `updateMemory` increments its version; explicit `supersedes` retires older facts. `forget` removes only authorized memory records and verifies absence in the canonical store. Source chunks cannot be deleted through memory operations.

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
- Workspace and session indexes are derivatives; explicit memories live in Zvec and require a backup before replacing their embedding space.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
