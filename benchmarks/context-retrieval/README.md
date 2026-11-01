---
description: "Reproduce local retrieval latency, recall, process memory, and context-packing measurements with synthetic data."
---

# Context retrieval benchmarks

English | [中文](README.zh.md)

## Summary

Compare lexical search, Zvec, real four-bit/two-bit turbovec, the combined reranker, and hybrid retrieval over generated source, documentation, conversation, and memory text. The runner uses built JavaScript in fresh processes and saves raw JSON. It is an optional diagnostic with no CI timing thresholds; the [report](report/README.md) records local results and their limits.

## Table of Contents

- [Run the comparison](#run-the-comparison)
- [Measurement endpoints](#measurement-endpoints)
- [Reproduce the packing control](#reproduce-the-packing-control)
- [Limits](#limits)
- [Dev Note](#dev-note)

<a id="run-the-comparison"></a>
## Run the comparison

Use Node 24.9+, the pinned pnpm, and a POSIX host with `ps` and `rg`. The supervisor supports macOS, Linux, and WSL; native Windows supervision is not implemented. Install the optional worker using the [retrieval guide](../../docs/user/guide/local-retrieval.md). From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm run setup
pnpm exec tsdown --config-loader native --config benchmarks/tsdown.config.ts
pnpm run bench:retrieval --sizes=1000,10000,100000 --queries=64 --python="$PWD/.testingplatform/retrieval-python/bin/python"
```

All text is generated from reviewed constants and seed 421337; no workspace, conversation, credential, or external model is read. Temporary corpus/index directories are owned and removed by the supervisor and worker. Default output is ignored `.testingplatform/retrieval-benchmark/results.json`; `--output=...` selects another private result file. Missing turbovec is recorded as an explicit skip.

Use `--modes=ann-sweep --sizes=100000` for the matched tuning diagnostic, or `--modes=zvec,combined`, `--runs=3`, `--queries=100`, or `--dimension=256` to narrow or repeat a comparison. Compression requires a dimension divisible by eight. The runner permits up to one million vectors, subject to native enumeration limits and available memory; that size is not part of the local validation.

<a id="measurement-endpoints"></a>
## Measurement endpoints

The comparison uses one caller, one query thread, one index-build thread, 256-dimensional normalized feature hashes, batch size 256, and the same 64 query prefixes. The initial matrix fixes legacy `hnswEf: 64`; `ann-sweep` measures the supported search-depth range and paired routes over one unchanged index. The product default is 2048 after that sweep. Each query has one known source record; exact float32 cosine search provides dense-ranking ground truth. Every indexed record is authorized by the benchmark principal; adversarial scope checks belong to the functional tests.

| Measurement | Included operation |
|---|---|
| Creation | Text embedding, canonical writes or compressed copies, and native optimization; individual phases are also saved |
| Warm query | `rg` process, native Zvec query, full-allowlist compressed query, or combined service query as labeled |
| Context | Unified search including query embedding, authorization, deduplication, and estimated-token packing |
| Cold activation | Reopen and first query with the OS page cache intact; standalone turbovec also rebuilds its ephemeral copy |
| Incremental | Canonical modes replace one percent of records including embeddings; excludes filesystem discovery. Baseline measures reference embeddings only, without lexical file updates |
| Recall and MRR | Recall@1/5/10 and reciprocal rank of the exact nearest result; intended-source hit rates are separate |
| CPU and memory | Node CPU/RSS plus sampled complete child-tree CPU/RSS at 100 ms; shared pages can be counted twice |
| IPC | Sixteen active-worker stats round trips, a framing/dispatch lower bound rather than search-kernel timing |

All modes retain a common exact-search matrix inside the diagnostic process. Baseline embedding time and that matrix are benchmark-reference overhead, not requirements of lexical retrieval. Raw query endpoints have different capabilities; compare the context-service column when judging the combined path. Sequential batch throughput uses concurrency one.

<a id="reproduce-the-packing-control"></a>
## Reproduce the packing control

`packing` repeatedly calls production `pack()` over fixed authorized candidates. The optimization prepares each passage’s token set once per operation. The negative-control patch restores repeated tokenization without changing emitted passages. Apply it only with the owning source saved and restore it afterward:

```sh
git apply benchmarks/context-retrieval/packing-negative-control.patch
pnpm run build:artifacts
pnpm run bench:retrieval --sizes=40,100 --modes=packing --runs=3 --queries=100 --output=.testingplatform/retrieval-benchmark/packing-before.json
git apply -R benchmarks/context-retrieval/packing-negative-control.patch
pnpm run build:artifacts
pnpm run bench:retrieval --sizes=40,100 --modes=packing --runs=3 --queries=100 --output=.testingplatform/retrieval-benchmark/packing-after.json
```

Compare every output hash and all raw samples. A measured speedup with changed emitted output is invalid. Keep independent CPU-heavy builds/tests stopped during timing runs.

<a id="limits"></a>
## Limits

These fixtures measure feature-hash ranking and storage/IPC overhead, not language understanding or real-model task accuracy. Token counts are estimates. Live model validation remains pending by user choice. No result establishes multi-user production readiness, a platform matrix, an equal-recall speedup, a stable population p99, or physical secure deletion.

<a id="dev-note"></a>
## Dev Note

The [decision record](../../.agents/notes/implemented/architecture/2026-11-01-authoritative-local-retrieval.md) owns storage and recovery rationale.
