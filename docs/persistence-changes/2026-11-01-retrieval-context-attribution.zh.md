---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-01-retrieval-context-attribution

[English](2026-11-01-retrieval-context-attribution.md) | 中文

## 概述

为持久化消息来源添加可选的检索上下文归属信息和证据指纹。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

现有来源分支、消息角色、内容和事件含义保持不变。新的 retrieval-tools 类型遵循现有 session-source-attribution 保留策略，ContextFormed 使用已有的上下文形式。遵循该策略的旧读取器会保留未知来源类型及其 JSON 元数据，并在未加载检索提供方时从日志生成记录的用户或开发者文本。新读取器继续接受旧消息和混合日志。仅检索提供方读取 fingerprint 以抑制重复上下文；该指纹不授予权限，也不增加回放或验证要求。没有该来源类型的会话保持现有行为。会话写入版本、头部和事件判别字段均不改变。

<a id="verification"></a>
## 验证

pnpm run test:e2e packages/retrieval --maxWorkers=2：2 个构建产物测试通过，1 个真实模型测试跳过。普通 Node 恢复检查仅导入核心 Session 和 LLM 包；未加载检索提供方时，旧用户消息以及新增检索用户和开发者消息的来源指纹、快照章节和消息内容均保持不变。配套测试确认构建入口共用公开索引类，并保留结构化授权错误。本次未运行已发布二进制文件的回放。

<a id="dev-note"></a>
## 开发备注

无。
