# Agent Note: Neural retrieval evidence classes

Status: implemented

English | [中文](2026-11-02-neural-retrieval-evidence-classes.zh.md)

## Problem

Neural embedding quality needs evidence, but the measuring host had no provider key and no reachable local embedding endpoint. A harness that reports a score for a route that never contacted a model turns a transport check into a semantic-quality claim, and a later reader cannot tell the two apart. Changing the embedding default on that basis would be worse than leaving it alone.

## Decision

The [neural relevance harness](../../../../benchmarks/context-retrieval/neural/run.mjs) labels every route result with one evidence class: `lexical-baseline` for the provider that runs without a model, `neural-model` for a route served by real weights over the configured endpoint, and `harness-plumbing` for `--selftest=true`, which returns token-digest vectors through the same OpenAI-compatible transport. Only `neural-model` sets `neuralQualityValidated`. A route whose endpoint probe fails is recorded in `report.pending` with the probe error and the exact command that clears it, and the run status is `partial-pending-live-neural-endpoint` rather than a pass.

Quality targets in [neural/cases.ts](../../../../benchmarks/context-retrieval/neural/cases.ts) are declared before measurement, including the margins a default change would need. A missed target stays in `targetVerdicts` as a failure; the multilingual and missing-evidence misses on the 2026-11-02 run were kept. Zvec stays the authoritative store, turbovec stays opt-in, and `local-hashed` stays the default provider.

## Alternatives considered

Reporting the self-test stand-in as dense-route quality was rejected: it exercises request framing, dimension agreement, embedding-space identity, and context packing, and says nothing about paraphrase retrieval. Requiring a live endpoint before landing anything was rejected because the deterministic harness, the pinned recipe, and the extended real-model suite are useful on their own and make the missing measurement cheap to complete. Relaxing the pre-declared targets to the measured values was rejected because it destroys the comparison the targets exist for.

## Consequences

Neural relevance stays an operator-runnable measurement rather than a repository claim, and the pinned recipe plus `modelRevision` make a reproduced run comparable. The embedding provider default changes only from a `neural-model` run that meets the declared margins. `modelRevision` must match the weights actually served, because the embedding-space key folds in provider, model, dimension, normalization, endpoint, and revision; a silent weight replacement would otherwise mix vectors that no longer share a space. Real-model E2E cases self-skip without `DEEPSEEK_API_KEY`, so CI silence is not validation, and the [decision record for authoritative storage](2026-11-01-authoritative-local-retrieval.md) still owns what Zvec and turbovec may each hold.
