---
description: "Persist authorized retrieval records in Zvec and optionally rerank dense candidates with an isolated turbovec worker."
kind: "package-reference"
---

# @deepseek-ai/dsh-retrieval-zvec

English | [中文](README.zh.md)

## Summary

Keep records, metadata, dense vectors, and full-text indexes on the local machine. Zvec serves keyword, cosine, and hybrid search without a database server. Enable the optional four-bit turbovec worker only for experiments; Zvec remains the fallback and authoritative memory store.

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
- name: '@deepseek-ai/dsh-retrieval-zvec'
  config:
    indexDir: .testingplatform/retrieval
    queryThreads: 1
    optimizeThreads: 1
    acceleratorEnabled: false
```

`enableMMAP` defaults to true. `hnswEf` defaults to 2048, the native maximum, following the measured high-recall setting in the [benchmark report](../../../benchmarks/context-retrieval/report/README.md). HNSW and full-text indexes share the same collection. Native filters enforce principal and scope ownership before scoring. An operating-system-backed exclusive writer lease prevents concurrent writers and is released on process death.

See the [configuration catalog](../../../docs/config-catalog.md) for accepted fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

`acceleratorEnabled` mounts real turbovec through `turbovecPython`; its default `acceleratorBitWidth` is 4, with 2 experimental. The worker accepts bounded JSON messages over private stdio, inherits no credentials, and filters by authorized IDs inside its native kernel. A restart starts an empty derivative; missing or invalid candidates safely select Zvec.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Retrieval group](../README.md) — package selection.
- [Local retrieval guide](../../../docs/user/guide/local-retrieval.md) — setup, recovery, and privacy.
- [Retrieval subsystem](../../../docs/subsystems/retrieval.md) — service ownership.

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-retrieval-tools`, which renders stored evidence.

#### KV Cache effect

No direct conversation cache effect. Search results change context only when a consumer exposes them.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- `pnpm run check:native-retrieval` exercises the real binding and the published entry points on the host that runs it; the [platform support matrix](../../../docs/user/guide/local-retrieval.md#platform-support) names which platform-and-architecture pairs a required lane covers and which stay untested.
- turbovec is an ephemeral compressed reranker, not a standalone persistent memory database. Its copies do not reduce canonical Zvec storage.
- Forgetting removes searchable records, not historical Session tool messages, backups, or recoverable filesystem blocks.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
