---
kind: upgrade-guide
description: "Agent preset Settings injection exposes the current Creator action through an observable hook instead of an optional callback."
---

# Creator availability uses an injected hook

English | [中文](guide.zh.md)

## Change

The published `@deepseek-ai/dsh-client-ui-agent-preset/client` type `AgentPresetSectionInjected` replaces optional `startCreatorDraft` with `hooks.creatorDraft`, an observable whose snapshot is `{ start: () => void } | null`. The renderer supplies `useCreatorDraft` to `AgentPresetSectionProps`. Custom Settings presentations and test fixtures implementing these types must update.

The observable follows Conversation activation, withdrawal and replacement while the Settings entry stays mounted. The Plugins menu keeps its existing provider-owned `startCreatorDraft` callback.

## Migration

1. Replace an injected `startCreatorDraft` property with a stable `hooks.creatorDraft` observable. Publish `{ start: action }` while the Conversation flow is active and `null` when it ends.
2. In a component, read `useCreatorDraft(flow => flow?.start)` and show the Creator entry only when the result exists. Tests that construct component props must supply the corresponding framework-bound selector hook.
3. Keep the same Settings entry mounted while activating, withdrawing and replacing Conversation. Confirm the Creator button appears, disappears and returns without remounting the Settings section.
