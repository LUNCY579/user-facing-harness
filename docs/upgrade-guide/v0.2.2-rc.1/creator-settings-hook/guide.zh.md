---
kind: upgrade-guide
description: "Agent preset 设置页通过可观察钩子提供当前创造模式动作，替代可选回调。"
---

# 创造模式可用状态改用注入钩子

[English](guide.md) | 中文

## 变更

公开类型 `@deepseek-ai/dsh-client-ui-agent-preset/client` 的 `AgentPresetSectionInjected` 将可选的 `startCreatorDraft` 替换为 `hooks.creatorDraft`，其可观察快照为 `{ start: () => void } | null`。渲染器为 `AgentPresetSectionProps` 提供 `useCreatorDraft`。实现这些类型的自定义设置页和测试夹具需要更新。

当设置注册项保持挂载时，该可观察源跟随 Conversation 的启用、撤回和替换。插件菜单仍使用原有的、由服务提供方拥有的 `startCreatorDraft` 回调。

## 迁移

1. 将注入的 `startCreatorDraft` 属性替换为稳定的 `hooks.creatorDraft` 可观察源。Conversation 流程可用时发布 `{ start: action }`，流程结束时发布 `null`。
2. 组件通过 `useCreatorDraft(flow => flow?.start)` 读取动作，仅在结果存在时显示创造模式入口。构造组件 props 的测试需要提供对应的、由框架绑定的选择器钩子。
3. 保持同一个设置注册项挂载，依次启用、撤回并替换 Conversation。确认创造模式按钮出现、消失并重新出现，而设置区块不会重新挂载。
