---
description: "本地工作区检索和显式分域记忆的包选择。"
kind: "package-group"
---

# retrieval/ — 本地上下文和记忆

[English](README.md) | 中文

## 摘要

检索本地文件和授权会话历史，并跨会话保留显式记忆。可选择离线哈希或由运维者管理的嵌入模型。Zvec 持久保存记录；可选的 turbovec 工作进程重排授权稠密向量候选。[检索子系统](../../docs/subsystems/retrieval.zh.md)定义共享服务职责。

## 目录

- [包](#packages)
- [相关文档](#related-documentation)
- [开发备注](#dev-note)

-----

<a id="packages"></a>
## 包

这些插件通过 Cordis 服务组合，保持智能体循环不变。

| 包 | 职责 |
|---|---|
| [`retrieval`](retrieval/README.zh.md) | 检索和显式记忆服务；工作区和会话同步入口，并定义版本化记忆导出、遗忘账本和导入日志。 |
| [`retrieval-embed`](retrieval-embed/README.zh.md) | 离线哈希和授权的 OpenAI 兼容嵌入。 |
| [`retrieval-zvec`](retrieval-zvec/README.zh.md) | 持久 Zvec 存储和可选隔离 turbovec 派生索引。 |
| [`retrieval-tools`](retrieval-tools/README.zh.md) | 智能体工具、操作者使用的记忆导出导入命令，以及可选自动上下文。 |

<a id="related-documentation"></a>
## 相关文档

- [本地检索指南](../../docs/user/guide/local-retrieval.zh.md) — 设置和恢复。
- [检索基准](../../benchmarks/context-retrieval/README.zh.md) — 可复现测量。

<a id="dev-note"></a>
## 开发备注

[记忆可迁移格式 Agent Note](../../.agents/notes/implemented/feature/2026-11-02-memory-portability-format.zh.md)定义导出、账本和暂存导入的决策。[权威本地检索 Agent Note](../../.agents/notes/implemented/architecture/2026-11-01-authoritative-local-retrieval.zh.md)定义存储权威性与可重建压缩。
