# Local neural embeddings

English | [中文](local-neural-embeddings.zh.md)

## Summary

Run paraphrase-capable retrieval with one embedding model that stays on your machine. The recipe pins BAAI/bge-m3 weights, serves them through a loopback OpenAI-compatible endpoint, and points the existing `local-openai-compatible` provider at that endpoint. No new embedding abstraction is involved, and no text leaves the host. The relevance harness that judges the result lives in [benchmarks/context-retrieval/neural](../../../benchmarks/context-retrieval/neural/).

## Table of Contents

- [Prerequisites](#prerequisites)
- [Install and serve the pinned model](#install-and-serve-the-pinned-model)
- [Point retrieval at the endpoint](#point-retrieval-at-the-endpoint)
- [Verify the space](#verify-the-space)
- [Measure relevance](#measure-relevance)
- [Limits](#limits)

<a id="prerequisites"></a>
## Prerequisites

Node 24.9 or newer, the repository setup from the [README](../../../README.md#run-from-source), and enough free RAM for one 567-million-parameter encoder. The pinned facts are verified upstream: BAAI/bge-m3 is MIT-licensed, emits 1024-dimensional dense vectors, accepts inputs up to 8192 tokens, covers more than 100 languages, and needs no query instruction prefix. Its Hugging Face revision is `5617a9f61b028005a4858fdac845db406aefb181`; the Ollama package is `bge-m3:567m` at about 1.2 GB.

<a id="install-and-serve-the-pinned-model"></a>
## Install and serve the pinned model

Install an embedding runtime that exposes `POST /v1/embeddings`, keep it bound to loopback, then pull the pinned tag:

```sh
ollama pull bge-m3:567m
ollama serve
curl -s http://127.0.0.1:11434/v1/models
```

The endpoint accepts `model`, `input` as a string or array of strings, and `dimensions`. Sending `input` as an array of token arrays is unsupported, so batching stays at the text level.

<a id="point-retrieval-at-the-endpoint"></a>
## Point retrieval at the endpoint

Copy the [neural overlay](../../../apps/cli/config/examples/retrieval-neural.yml), then launch with it. The example sets `provider: local-openai-compatible`, `model: bge-m3:567m`, `dimension: 1024`, `baseUrl: http://127.0.0.1:11434/v1`, and pins `modelRevision`. It also selects fresh `indexDir` and `statePath` values, because an existing index holds a different embedding space and the store refuses to mix spaces.

```sh
pnpm start --patch "$PWD/apps/cli/config/examples/retrieval-neural.yml"
```

`maxBatch` bounds one request body. `timeoutMs` bounds a deadline. `apiKeyEnv` stays empty: a loopback endpoint takes no credential, and an ambient `OPENAI_API_KEY` is never attached.

<a id="verify-the-space"></a>
## Verify the space

Ask a tool-capable model to call `memory_status`, then call `context_index` with `source: "workspace"`, then `workspace_semantic_search` with a paraphrase of an indexed sentence and `mode: "semantic"`. `memory_status` reports the embedding space and backend health. A dimension or revision mismatch fails at load with `space_mismatch` instead of comparing vectors across spaces.

<a id="measure-relevance"></a>
## Measure relevance

From the repository root, build the measured worker and run the comparison:

```sh
pnpm exec tsdown --config-loader native --config benchmarks/tsdown.config.ts
pnpm run bench:retrieval:neural --output=.testingplatform/retrieval-neural/results.json
```

The runner probes the endpoint first. Reachable: it measures `keyword`, `hashed`, `dense`, and `hybrid` over one synthetic corpus under identical query settings and writes relevance, citation validity, latency, process memory, model and runtime versions, and every failed target. Unreachable: it measures the two lexical routes, records the neural routes as pending with the probe error, and exits without inventing numbers. `--selftest=true` starts a deterministic loopback stand-in that is arithmetic over token digests; it proves the pipeline end to end and labels its rows `harness-plumbing`, never neural evidence.

<a id="limits"></a>
## Limits

The corpus and queries are authored constants, so the scores rank the routes against each other rather than predict your workload. Relevance targets are fixed in [cases.ts](../../../benchmarks/context-retrieval/neural/cases.ts) before measurement; recorded misses stay recorded. Zvec remains the default durable store and turbovec stays opt-in — no measured evidence in this repository yet justifies changing either. Switching providers or revisions requires a fresh `indexDir` and re-indexing; explicit memories need deliberate migration. The [retrieval guide](local-retrieval.md) owns scopes, recovery, and privacy.
