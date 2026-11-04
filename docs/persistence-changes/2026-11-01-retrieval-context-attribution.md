---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-01-retrieval-context-attribution

English | [中文](2026-11-01-retrieval-context-attribution.zh.md)

## Summary

Adds optional retrieval-context attribution and evidence fingerprints to persisted message sources.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-01-retrieval-context-attribution
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-27-retry-control-input"
    after: "f6f8afa331bdcaff254f7c46354069c3b9de9f46440c3115e2fce59c70fd7c8c"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-27-retry-control-input"
    after: "d3357d6ae741e4c0560ed8068a649660127fbbd99173e1104702d9b9287753f8"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-27-retry-control-input"
    after: "2427def41f689b7258b01a4eb1cda5d116b71c00f2d29834075b1dd9c18a4368"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-27-retry-control-input"
    after: "597ad688b9d8e880f0668a85359a3362f49e886c9bd3fddd77ea86d81921a0d9"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing source alternatives, message roles, contents, and event meanings remain unchanged. The new retrieval-tools kind is qualified under the existing session-source-attribution preservation policy, and ContextFormed uses already supported context forms. Policy-compatible older readers preserve the unknown source kind and its JSON metadata and derive the recorded user or developer text without the retrieval producer. New readers continue to accept legacy messages and mixed logs. Only the retrieval producer reads fingerprint to suppress duplicate context; the fingerprint grants no authority and imposes no replay or validation requirement. Sessions without this kind retain their existing behavior. The Session writer, header, and event discriminators do not change.

<a id="verification"></a>
## Verification

pnpm run test:e2e packages/retrieval --maxWorkers=2: 2 built-artifact tests passed and 1 live-model test was skipped. The plain Node restore probe imports only the core Session and LLM packages. It preserves a legacy user message and new retrieval user/developer source fingerprints, snapshot sections, and message content without the retrieval producer. The companion test preserves the public indexing class and structured authorization errors across its built entry. No released-binary replay was run.

<a id="dev-note"></a>
## Dev Note

None.
