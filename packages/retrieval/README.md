---
description: "Local workspace retrieval and explicit scoped memory package selection."
kind: "package-group"
---

# retrieval/ — local context and memory

English | [中文](README.zh.md)

## Summary

Search local files and authorized Session history, and retain explicit memories across sessions. Choose the offline hash provider or an operator-managed embedding model. Zvec persists records; an optional turbovec worker reranks authorized dense candidates. The [retrieval subsystem](../../docs/subsystems/retrieval.md) defines shared service ownership.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

These plugins compose through Cordis services and leave the agent loop unchanged.

| Package | Role |
|---|---|
| [`retrieval`](retrieval/README.md) | Search and explicit memory service; workspace and Session synchronization entry, and the versioned memory export, ledger, and journal. |
| [`retrieval-embed`](retrieval-embed/README.md) | Offline hashing and authorized OpenAI-compatible embeddings. |
| [`retrieval-zvec`](retrieval-zvec/README.md) | Persistent Zvec store and optional isolated turbovec derivative. |
| [`retrieval-tools`](retrieval-tools/README.md) | Agent tools, the operator portability commands, and opt-in automatic context. |

<a id="related-documentation"></a>
## Related documentation

- [Local retrieval guide](../../docs/user/guide/local-retrieval.md) — setup and recovery.
- [Retrieval benchmarks](../../benchmarks/context-retrieval/README.md) — reproducible measurements.

<a id="dev-note"></a>
## Dev Note

The [memory portability format Agent Note](../../.agents/notes/implemented/feature/2026-11-02-memory-portability-format.md) owns the export, ledger, and staged-import decisions. The [authoritative local retrieval Agent Note](../../.agents/notes/implemented/architecture/2026-11-01-authoritative-local-retrieval.md) owns store authority and rebuildable compression.
