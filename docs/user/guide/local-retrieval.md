# Local context retrieval and explicit memory

English | [中文](local-retrieval.zh.md)

## Summary

Enable local source search and explicit memory without a database server or cloud embedding account. The default hashed embedding provider is deterministic lexical feature hashing, not a trained semantic model. For paraphrase retrieval, configure a local embedding server you control. All retrieval plugins are disabled in the shipped base profile.

## Table of Contents

- [Enable and verify](#enable-and-verify)
- [Call the tools](#call-the-tools)
- [Choose memory ownership](#choose-memory-ownership)
- [Choose embeddings and acceleration](#choose-embeddings-and-acceleration)
- [Recover or disable](#recover-or-disable)
- [Privacy and verification limits](#privacy-and-verification-limits)
- [Dev Note](#dev-note)

## Enable and verify

Complete the [repository setup](../../../README.md#run-from-source), using Node 24.9 or newer. From the repository root, launch the combined application with the optional overlay:

```sh
pnpm start --patch "$PWD/apps/cli/config/examples/retrieval.yml"
```

The [overlay](../../../apps/cli/config/examples/retrieval.yml) uses the launch directory as its indexing root. Select that same directory as the session's workspace. To index another project, copy the overlay and change `retrieval-indexing.config.roots` to selected absolute directories within that project's original workspace. Do not replace an existing private profile patch without preserving its other entries.

Choose an available tool-capable model. Ask it to call `context_index` with `{"source":"workspace"}`, then `workspace_semantic_search` with a symbol from an indexed file and `mode: "keyword"`. A successful result contains the original path, line range, source text, and a retrieval score. `memory_status` reports the embedding space and backend health. Searches never trigger a filesystem scan; repeat indexing after edits, renames, or deletions.

Runtime state uses the profile's Harness home: the combined launcher defaults to ignored `.testingplatform/`, or your configured `DSH_HOME`. The overlay stores retrieval data below that home. No embeddings, memories, or private source documents belong in Git.

## Call the tools

These names are model-facing tools, including through the normal PTC tool bridge. The [generated catalog](../../tool-catalog.md#deepseek-aidsh-retrieval-tools) owns complete schemas.

| Tool | Use |
|---|---|
| `context_index` | Synchronize workspace files or authorized workspace sessions; rebuild source derivatives |
| `context_search` | Hybrid retrieval across allowed source text and memories |
| `workspace_semantic_search` | Workspace keyword, dense-vector, or hybrid search with source references |
| `vector_similarity_search` | Dense-vector nearest-neighbor search |
| `memory_search` | Query memories, or list them without a query |
| `memory_remember` | Explicitly save a scoped fact, with optional tags and expiration |
| `memory_update` | Correct a memory by its returned ID and increment its version |
| `memory_forget` | Delete authorized IDs, expired memories, or selected memory scopes |
| `memory_status` | Inspect local store, embedding, and accelerator health |

For a synthetic workflow, ask the agent to remember `Synthetic project review day is Tuesday` in `workspace` scope. Save the returned ID. Start a new session in the same workspace and search for `project review day`. Correct that ID to Thursday with `memory_update`, then search again. Only the corrected stored value is current. Finally call `memory_forget` with that ID; search again after restarting to verify absence.

No query is needed to list memories. Use `scopes` to narrow the list. `ttl_days` on creation sets expiration; expired entries disappear from retrieval and remain stored until a matching forget sweep. `memory_update` accepts `expires_at: null` to remove expiration. Exact duplicates reuse the same memory; contradiction handling requires an explicit correction or supersession.

Automatic context is separately opt-in: set `retrieval-tools.config.autoRetrieval: true` in a copied overlay. It requires the base profile's `sessionQuery` service. Its defaults select at most four passages above `autoMinScore: 0.35`, under `autoBudgetTokens: 600` estimated tokens, for queries of at least 24 characters. An unchanged selected evidence set already committed in that session is not injected again, even if its ranking or scores change. New content or memory versions can produce a new logged message. Automatic deduplication asynchronously reads and scans the session log, so long logs add a reading and scanning cost.

## Choose memory ownership

Memory creation always names a scope. The host supplies identity and permissions; model-generated user, workspace, or session IDs cannot grant access.

| Scope | Who can retrieve it |
|---|---|
| `workspace` | The configured local principal in the original workspace |
| `session` | That principal and session; other sessions in the workspace require `crossSessionRead: true` |
| `agent` | The same principal, workspace, and agent |
| `user` | The same configured principal across workspaces, only with `persistentMemory: true` |

The example keeps personal persistence and cross-session transcript access off. Explicit workspace memories already support same-workspace recall in a new session. Enable personal persistence only when you intend to retain user-level facts. No component silently extracts personal facts from every conversation. Session text indexing also requires `retrieval-indexing.config.indexSessions: true` and an explicit `context_index` call with `source: "sessions"`; it covers authorized live and persisted workspace sessions.

`localPrincipal` defaults to the operating-system username. It is a trusted local configuration label, not an authentication system for multiple browser users. Original local session logs are treated as belonging to that operator; this label cannot establish ownership in a shared multi-user log store. Use the canonical workspace path when opening a session; symlink aliases are rejected so restarting cannot retarget its authority. Changing the working directory inside a session does not grant another workspace's memory access.

## Choose embeddings and acceleration

Choose the provider before creating an index. Embedding provider, model, endpoint identity, weight revision, normalization, and dimension identify compatible vectors. A mismatch fails visibly instead of mixing spaces. Set `modelRevision` when the same server model ID can refer to replaced weights.

- `local-hashed` works immediately without network access or downloaded model weights. It is useful for deterministic keyword-oriented retrieval and benchmarks.
- `local-openai-compatible` sends text only to a configured loopback HTTP(S) embedding endpoint. Start and configure your own local embedding runtime, and match its model ID and output dimension. TestingPlatform does not install model weights.
- `openai-compatible` requires `allowRemoteEmbeddings: true` and a credential in the configured `apiKeyEnv`. Enabling it authorizes sending indexed text and queries to that provider. Keep it off unless the document owner explicitly permits that upload.

The [embedding package](../../../packages/retrieval/retrieval-embed/README.md) owns provider fields and transport limits. Local HTTP behavior is tested with synthetic fixtures; no cloud embedding provider or real neural model is claimed as validated here.

Zvec runs independently and is the default. To experiment with turbovec, install the tested optional worker dependencies with Python 3.11 or newer in an ignored environment (locally tested with Python 3.12.6):

```sh
python3 -m venv .testingplatform/retrieval-python
.testingplatform/retrieval-python/bin/python -m pip install turbovec==1.1.2 numpy==2.3.5
```

In a copied overlay, set `retrieval-zvec.config.acceleratorEnabled: true`, set `turbovecPython` to that environment's absolute Python path, and set `retrieval.config.useAccelerator: true`. Four-bit compression is the default; two-bit compression is experimental. The worker is a rebuildable dense reranker, not a standalone persistent memory store. Missing or failed workers fall back to authorized Zvec retrieval. Read the [local benchmark report](../../../benchmarks/context-retrieval/README.md) before enabling acceleration for a workload.

## Recover or disable

Use the reported operation and failure code to choose recovery. Keep the application stopped while copying or restoring its index directory.

| Situation | Action |
|---|---|
| Files changed or disappeared | Run `context_index` with `source: "workspace"`; hashes detect repeated or changed content |
| Source index is stale or its derivative ledger is corrupt | Run `context_index` with `source: "rebuild"`; authorized source chunks are cleared and rebuilt, while explicit memories remain |
| Memory write reports `outcome_pending` | Inspect `memory_status`; run `context_index` with `source: "rebuild"` to finish the authorized staged change before dependent work |
| Embedding model, weights, endpoint, or dimensions changed | Back up the old index; choose new `indexDir` and `statePath` values and reindex; explicit memory migration is manual |
| Canonical Zvec collection is corrupt | Stop and restore a known-good backup; a source rebuild cannot repair lost explicit memories |
| turbovec is unavailable | Use Zvec; inspect `memory_status` and correct the worker path or dependencies before restarting |
| Remove memories | Call `memory_forget` with IDs or authorized scopes; deletion is verified in canonical storage |
| Hide tools temporarily | Set `retrieval-tools.config.enableTools: false` and keep automatic retrieval off |
| Disable the subsystem | Omit the optional overlay, or disable all five retrieval rows in the profile |

A rebuild re-reads configured files and authorized workspace sessions available through Session persistence; it cannot reconstruct unavailable source logs or an explicit memory deleted from the authoritative store. An embedding-space change does not migrate memories automatically. Keep old backups protected: they can still contain forgotten facts.

## Privacy and verification limits

The indexer excludes common secret files, credentials, generated directories, runtime state, and `.git` by default. It rejects path traversal and symlink escapes. These exclusions cannot identify a secret pasted into an otherwise ordinary source file: choose indexing roots deliberately. Retrieved text is untrusted evidence and never becomes a system instruction.

Forgetting removes searchable records and prevents stale accelerator IDs from returning them. It does not erase old Session tool results, filesystem history, backups, or recoverable storage blocks. Explicitly indexed transcripts and files can still contain the same fact independently of the deleted memory ID. Use each original system's retention controls for those copies.

The [keyless headless recording](../../../snapshots/session/local-retrieval/snapshot.yml) verifies source-linked indexing and retrieval through the shipped profile. The [real Loader workflow](../../../packages/retrieval/retrieval-tools/tests/composition.spec.ts) verifies synthetic cross-session recall, correction, restart-safe deletion, worker fallback, and same-store workspace isolation with a local scripted model. These tests establish tool orchestration rather than real-model task accuracy. The indexer requires the session filesystem to map the same native host directory; SSH and unrelated execution worlds are rejected. Only macOS arm64 native execution is exercised locally; this integration is suitable for local experimentation and does not establish multi-user production readiness.

## Dev Note

None.
