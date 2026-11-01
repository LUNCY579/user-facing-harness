---
description: "Choose deterministic offline hashing, a local embedding model endpoint, or explicitly authorized remote embeddings."
kind: "package-reference"
---

# @deepseek-ai/dsh-retrieval-embed

English | [中文](README.zh.md)

## Summary

Generate normalized vectors without requiring a cloud service. The default feature-hash provider needs no model download and measures lexical overlap. Use a local OpenAI-compatible embedding endpoint for neural semantic retrieval, or explicitly authorize a remote provider.

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
- name: '@deepseek-ai/dsh-retrieval-embed'
  config:
    provider: local-hashed
    model: dsh-hashed-v1
    dimension: 256
```

`local-openai-compatible` requires a loopback `baseUrl` and an exact installed `model`; it does not download weights. `openai-compatible` requires `allowRemoteEmbeddings: true`. Both reject redirects, validate response dimensions and finite values, bound response bytes, and honor cancellation and request deadlines. `apiKeyEnv` defaults to empty: local endpoints receive no token unless you name a credential variable; remote providers require an explicit variable and its credential. Unloading aborts HTTP requests and retry waits and awaits their settlement.

See the [configuration catalog](../../../docs/config-catalog.md) for accepted fields.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Provider, endpoint identity, model, model revision, dimension, and normalization identify the embedding space. A changed space requires a separate index directory and explicit memory migration; incompatible vectors never mix. Set `modelRevision` when replacing weights behind an unchanged endpoint and model name. `maxBatch` bounds requests, and local hashing yields between batches.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Retrieval group](../README.md) — package selection.
- [Local retrieval guide](../../../docs/user/guide/local-retrieval.md) — setup, recovery, and privacy.
- [Retrieval subsystem](../../../docs/subsystems/retrieval.md) — service ownership.

<a id="model-experience"></a>
## Model Experience

None, as embedding vectors do not enter conversation requests.

#### KV Cache effect

No direct conversation cache effect. Remote embedding requests are separate requests to the configured endpoint.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Hashing is lexical retrieval, not learned semantic understanding.
- Neural quality depends on an operator-installed embedding model and server; no model weights are bundled.
- Allowing a remote provider uploads query and indexed text to that provider.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
