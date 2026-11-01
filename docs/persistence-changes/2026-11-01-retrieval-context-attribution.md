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
    previous: "2026-10-22-action-card-status"
    after: "534115c0b4a9ae738f239bb2b3c30b25eaead4444f95f1ad628c729ea68ccc16"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-22-action-card-status"
    after: "559cdd40969a4e9fff241dc5e14ff6167535f3db3c9d107a23ca23acedb542d3"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-22-action-card-status"
    after: "3d199555b38c8049773ac8fe7419eceea404b5ce8e5fabe22f96670ca0a444aa"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-22-action-card-status"
    after: "e84eff45b49dce0fcba735fe431a90154988fc6a56f7319544f098057d39a68d"
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
