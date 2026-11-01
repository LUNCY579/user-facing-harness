---
description: "Local retrieval benchmark evidence, security review, verification results, and deployment limits."
---

# Local retrieval engineering report

English | [中文](README.zh.md)

## Summary

The native Cordis composition supports workspace and historical-session retrieval, explicit scoped memory, and bounded source-linked context. Zvec owns durable records; real turbovec is an optional ephemeral dense reranker. Local deterministic workflows and native benchmarks run on macOS arm64. Live model reasoning and neural embedding quality remain pending by user choice; this is suitable for local experimentation, not a multi-user production approval.

## Table of Contents

- [Architecture and scope](#architecture-and-scope)
- [Measured results](#measured-results)
- [Quality and defaults](#quality-and-defaults)
- [Packing optimization](#packing-optimization)
- [Security and reliability review](#security-and-reliability-review)
- [Workflow verification](#workflow-verification)
- [Checks and working tree](#checks-and-working-tree)
- [Readiness and limitations](#readiness-and-limitations)
- [Dev Note](#dev-note)

<a id="architecture-and-scope"></a>
## Architecture and scope

Four packages under [packages/retrieval](../../../packages/retrieval/README.md) provide service definitions and orchestration (`retrieval`), local/HTTP embeddings (`retrieval-embed`), native storage and the isolated Python worker (`retrieval-zvec`), and nine agent tools plus optional pre-step context (`retrieval-tools`). The base bundle declares all five plugin rows disabled; the [overlay](../../../apps/cli/config/examples/retrieval.yml) enables them without editing the agent loop or model adapters. The [guide](../../../docs/user/guide/local-retrieval.md) owns installation and recovery; the [subsystem reference](../../../docs/subsystems/retrieval.md) owns API semantics.

Workspace synchronization handles hashes, edits, renames, deletion, exclusions, bounded chunks, and interrupted writes. Authorized historical Session indexing reads user/assistant text without modifying logs. Explicit memories support user/workspace/session/agent scopes, timestamps, attribution, expiry, exact deduplication, staged supersession, and verified deletion. Automatic personal extraction is absent; personal persistence, historical indexing, remote embeddings, and automatic context are separate opt-ins.

The official [Zvec](https://github.com/alibaba/zvec) Node SDK is pinned at 0.8.0 (Apache-2.0); [turbovec](https://github.com/RyanCodrai/turbovec) 1.1.2 (MIT) runs through its real Python bindings with NumPy 2.3.5. Neither upstream is forked. This adapter exposes dense cosine, full-text, and hybrid retrieval; sparse-vector APIs are not exposed. Standalone compressed search is benchmarked as a component, not offered as a durable memory database.

<a id="measured-results"></a>
## Measured results

Measured on 2026-11-01: Apple M2, eight logical CPUs, 8 GiB memory, Darwin 27.0.0 arm64, Node 24.22.1, Python 3.12.6. A fresh process owns each case, with one build/query thread, concurrency one, seed 421337, normalized 256-dimensional feature hashes, 64 queries, and exact Float32 cosine ground truth. Text templates cover source, documentation, conversation, and memory labels; they are a controlled synthetic lexical corpus, not representative neural embeddings. The [method](../README.md) defines endpoints and commands.

The initial matrix fixes legacy `hnswEf: 64` and one creation per case. Raw p50 measures different endpoints: baseline spawns `rg` and returns one exact match; Zvec and hybrid call native search; turbovec scans the authorized full corpus; combined calls the complete top-10 service. Context p50 uses the shared top-six, 1200-estimated-token service endpoint. Do not interpret these raw columns as equivalent features or equal-recall speedups.

| Vectors | Mode | Create s | Raw p50 ms | Context p50 ms | Recall@10 | Peak tree MiB |
|---:|---|---:|---:|---:|---:|---:|
| 1,000 | baseline | 0.1 | 7.63 | — | 0.100 | 92 |
| 1,000 | zvec | 2.3 | 0.75 | 2.25 | 0.966 | 227 |
| 1,000 | turbovec4 | 0.7 | 0.66 | — | 0.894 | 122 |
| 1,000 | turbovec2 | 0.4 | 0.70 | — | 0.723 | 137 |
| 1,000 | combined | 2.9 | 4.14 | 2.61 | 0.919 | 245 |
| 1,000 | hybrid | 2.8 | 1.40 | 3.35 | 0.169 | 208 |
| 10,000 | baseline | 2.4 | 13.33 | — | 0.100 | 149 |
| 10,000 | zvec | 29.1 | 1.77 | 3.80 | 0.875 | 347 |
| 10,000 | turbovec4 | 2.0 | 4.75 | — | 0.889 | 227 |
| 10,000 | turbovec2 | 1.8 | 4.76 | — | 0.620 | 230 |
| 10,000 | combined | 18.5 | 7.08 | 3.87 | 0.852 | 368 |
| 10,000 | hybrid | 23.3 | 2.25 | 3.65 | 0.145 | 289 |
| 100,000 | baseline | 11.0 | 29.57 | — | 0.100 | 236 |
| 100,000 | zvec | 346.6 | 3.74 | 3.94 | 0.627 | 811 |
| 100,000 | turbovec4 | 18.0 | 70.75 | — | 0.792 | 408 |
| 100,000 | turbovec2 | 25.8 | 47.99 | — | 0.564 | 448 |
| 100,000 | combined | 1017.7 | 4.71 | 2.25 | 0.616 | 795 |
| 100,000 | hybrid | 187.8 | 3.40 | 3.42 | 0.161 | 793 |

The [raw matrix](../results/matrix.json) and [CSV](../results/summary.csv) include all samples, p95/p99, sequential throughput, recall@1/5/10, MRR, cold reopen, embedding time, one-percent updates, CPU, disk, and IPC. Baseline Recall@10 is 0.1 because it deliberately returns one correct source, not because it misses that source. Hybrid favors lexical evidence, so dense-ground-truth recall understates its intended-source behavior: at 100k its source hit@1 is 0.969 versus 0.766 for Zvec. Baseline incremental samples measure reference embeddings only, without rewriting lexical files; CSV incremental update fields are therefore omitted for that mode.

Each mode retains the same reference matrix; sampled RSS includes that fixture, Node/native/Python runtimes, and possibly double-counted shared pages. It is not index-only RAM or proportional set size. Cold reopening retains the OS page cache; ephemeral turbovec also requires rehydration. Compression does not shrink authoritative Zvec files. Creation varied widely (100k combined took 1018 seconds); one run on an active 8 GiB desktop does not support a reliable creation-speed ranking. Query samples from one graph are not independent population replications, and 64 samples do not establish a stable tail p99.

<a id="quality-and-defaults"></a>
## Quality and defaults

A separate [same-graph sweep](../results/ann-sweep.json) reopens one 100k Zvec index with each search depth. The accepted default is `hnswEf: 2048`: it reaches 0.958 Recall@10 and 1.0 Recall@1 on this corpus, with 3.49 ms native p50. This is an observed synthetic quality target, not a universal guarantee. An attempted 4096 run [failed at the native limit](../results/ann-limit-failure.json); configuration now rejects values above 2048.

| hnswEf | Native p50 ms | Recall@1 | Recall@10 |
|---:|---:|---:|---:|
| 128 | 0.76 | 0.875 | 0.737 |
| 256 | 1.14 | 0.969 | 0.839 |
| 512 | 1.74 | 0.984 | 0.914 |
| 1024 | 2.55 | 1.000 | 0.944 |
| 2048 | 3.49 | 1.000 | 0.958 |

Matched complete-service routes over that same graph show combined p50 of 2.02 versus Zvec 1.72 ms at ef64, and 4.14 versus 3.76 ms at ef1024. Every combined query actually used the worker. That is roughly 18% and 10% extra latency with unchanged intended-source hit rates, so automatic performance routing has no evidence-based threshold and the default stays Zvec. Four-bit standalone compression retains more dense recall than two-bit (100k Recall@10 0.792 versus 0.564), but scans are slower here and operate at different quality from tuned ANN. Two-bit remains experimental; no equal-recall compression speedup is claimed.

<a id="packing-optimization"></a>
## Packing optimization

Production context packing prepares passage token sets once per operation instead of repeatedly tokenizing each pair. Three fresh processes per variant and 100 samples per process use the reproducible [negative-control patch](../packing-negative-control.patch). The median process p50 falls from 6.425 to 0.610 ms for 40 candidates (10.53×), and from 40.378 to 3.314 ms for 100 (12.18×). All before/after output hashes match. [Before](../results/packing-before.json) and [after](../results/packing-after.json) preserve every sample; no substantial RAM saving is established. No persistent query cache is added.

<a id="security-and-reliability-review"></a>
## Security and reliability review

Independent component audits and deterministic adversarial tests identified and repaired the following prioritized defects. Priorities describe the consequence if deployed, not a claim of a published vulnerability. Regression evidence is in the owning package tests.

| Priority | Confirmed risk | Repair and verification |
|---|---|---|
| High | Scope and path confusion could admit another workspace or wrong execution world. | Host-derived branded identity, canonical original cwd, local filesystem mapping, native filter-first predicates; cross-user/workspace/session/agent and symlink tests. |
| High | Interrupted memory supersession could hide the predecessor without a current successor. | Hidden pending successor, durable intent recovery, serialized publication, explicit unknown outcome; injected write failures and restart checks. |
| High | Silent delete/write rejection and incomplete derivative synchronization could report success with stale records. | Verify canonical absence/accepted writes, include expired and superseded memory in scoped deletion, journal pending source IDs, rebuild/fallback from canonical records; restart and fault tests. |
| High | Ambient API credentials, reflected HTTP errors, or redirect behavior could disclose private inputs. | Empty default credential name, explicit remote consent, loopback/redirect checks, scrubbed error detail, bounded HTTP bodies and lifecycle abort; local HTTP adversarial tests. |
| High | Worker lifetime and competing writers could leave resources or corrupt shared ownership. | OS SQLite exclusive writer lease, bounded credential-free isolated worker, await active and failed process exits, serialized drain/close; lock, actual crash/restart, timeout and malformed-protocol tests. |
| Medium | Built indexing entry duplicated service/error classes; case folding hid distinct facts; native prefix limits hid authorized records. | Public-entry shim identity assertions, case-sensitive exact deduplication, native prefix predicates and explicit enumeration bounds; built-consumer and adversarial regression tests. |
| Medium | Repeated context deduplication and tiny budgets could omit attribution or suppress changed facts. | Logged evidence fingerprint includes content/version, complete empty-result rendering fits accepted budgets, reject invalid limits; tool tests and recorded Session snapshot. |

Prompt framing labels retrieved text as untrusted user evidence and preserves source links; it cannot guarantee a model resists every malicious document. Secrets and ignored paths are excluded before reading, but no filename policy can identify every secret embedded in an otherwise permitted file. Local files, stores, worker executable, and Harness home belong to one trusted operator.

<a id="workflow-verification"></a>
## Workflow verification

The Loader-based integration starts real Cordis services, real Zvec, and a tool-capable scripted adapter. It exercises A–F with synthetic records and actual tool dispatch; this validates orchestration and assertions, not model reasoning. The [workflow metrics](../results/agent-workflow.json) record all assertions and estimated input counts.

| Scenario | Verified observation |
|---|---|
| A | Index sample workspace; retrieve function evidence with path and line references; ignored secret fixture stays absent. |
| B | Explicitly remember in Session A, close it, retrieve in Session B without replaying A into B. |
| C | Correct the synthetic value; retrieval admits the latest version and hides its superseded predecessor. |
| D | Forget, inspect canonical absence, restart, and confirm retrieval remains empty; source logs stay intact. |
| E | Optional backend unavailable or inconsistent; canonical authorized Zvec result still arrives. |
| F | Another workspace cannot retrieve highly similar restricted facts from the same store; component tests also cover user/session/agent separation. |

The recorded warm keyword follow-up reaches the first scripted model request containing evidence in 3.74 ms. Estimated model input increases from 2206 to 2337 tokens (+131) in that measured run; this is added evidence, not demonstrated token savings. Counts use a documented heuristic, not provider usage. Whole-task model accuracy, answer latency, neural semantic quality, and token savings remain unmeasured. Later schema/copy changes can alter the regenerated fixture counts.

<a id="checks-and-working-tree"></a>
## Checks and working tree

Initial implementation checks include 225 focused tests, two built-consumer e2e tests with one live-model skip, 14 platform tests, 94 plugin suites, and two selected keyless replay/corpus checks. The implementation application artifacts, Host/Client aggregate type checks, full lint, enabled/disabled Web smokes, and documentation website build pass. The record distinguishes initial aggregate failures from their focused corrections.

The [verification record](../results/verification.json) lists exact executed commands, exit results, exclusions, and corrected initial failures. It distinguishes focused native tests, built-consumer e2e, keyless replay, platform integration, both enabled/disabled Web smokes, and the existing Our Free Model contributor suite. Live provider validation is explicitly pending. The original record retains repository-wide failures observed during implementation. Repairs cover the four README pairs, workspace peer declarations with compatible external packing, the rescope buffer, and ownership scoping for the pinned import. [Repository checks](../results/repository-checks.json) records validation after those repairs.

The implementation branch is `feat/local-retrieval-readiness`. The [file inventory](../results/working-tree.txt) captures tracked edits and new files before publication, including four retrieval packages, fixtures, configuration, catalogs, benchmark sources/evidence, and platform smoke coverage. Initial unfinished retrieval edits are incorporated. Initial unrelated `.installer-node-version` and `start-demo.command` are preserved. The inventory describes its capture time; Git history records subsequent commits and publication. Runtime indexes, embeddings, Python/Node installations, and private logs remain ignored under `.testingplatform/`.

<a id="readiness-and-limitations"></a>
## Readiness and limitations

- Recommended local configuration: Zvec, memory mapping enabled, one query/build thread, hnswEf2048, local feature hashes for deterministic code/lexical experiments or an explicitly selected loopback neural embedding service. Keep turbovec, personal persistence, history indexing, and automatic retrieval disabled until needed.
- Verified platform: macOS arm64 only. Linux/WSL benchmark supervision is implemented but not exercised here; Windows native supervisor is absent. Native SDK/wheel availability and other operating systems require CI or host testing.
- The trusted local host is not an authenticated multi-tenant service. Deploy separate stores/homes per operating-system operator. No remote tenant isolation claim is made.
- File synchronization is explicit, not a continuous watcher or whole-workspace snapshot transaction. Long synchronous native calls cannot be interrupted mid-call; bounded batches allow cancellation between calls.
- Forgetting verifies logical absence in authoritative retrieval records and drops compressed copies; it is not forensic erasure. Historical Session messages, backups, or independently indexed source facts can retain the same text.
- Feature hashes are deterministic lexical projections, not a bundled neural semantic model. Model-space changes require a separate index; source chunks can rebuild, but explicit memories require deliberate migration or backup.
- Live tool-capable model validation and real neural retrieval relevance are pending by explicit user choice. No key or running Ollama service was available. No private document was sent to a remote embedding provider.

<a id="dev-note"></a>
## Dev Note

All performance numbers above are local measurements, not upstream published claims. Raw JSON contains generated measurements only; machine-specific repository/home paths are replaced with placeholders. The [decision record](../../../.agents/notes/implemented/architecture/2026-11-01-authoritative-local-retrieval.md) owns durable storage and recovery rationale.
