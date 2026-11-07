---
description: "统一的本地检索和显式分域记忆，支持授权、过期、更正和删除。"
kind: "package-reference"
---

# @deepseek-ai/dsh-retrieval

[English](README.md) | 中文

## 概述

通过统一服务检索工作区证据和显式保存的记忆。个人记忆默认关闭，返回上下文受相关性和估算 token 数限制。此服务需要同时挂载嵌入提供方和持久存储；可选工具提供智能体访问。

## 目录

- [使用此包](#use-this-package)
- [了解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

通过[完整本地检索配置](../../../docs/user/guide/local-retrieval.zh.md)挂载所有必要服务。以下条目用于在该组合中配置此包。

```yaml
- name: '@deepseek-ai/dsh-retrieval'
  config:
    persistentMemory: false
    crossSessionRead: false
    useAccelerator: false
    portabilityEnabled: false
```

`enabled` 控制全部操作。`maxTextChars`、`maxTopK` 和 `maxPendingWrites` 限制输入、结果和写入队列。`maxMemories` 统计所有保留的记忆，包括已过期和被替代的记录。记忆查询在评分前执行由宿主解析的主体、工作区、会话和智能体权限；模型参数无法选择身份。

`portabilityEnabled: true` 允许显式记忆导出与导入，并使遗忘操作在删除之前写入账本条目。此时 `portabilityDir` 必须是仓库之外的绝对目录，`maxPortabilityRecords` 限制单次导出规模。启用可迁移但未提供绝对 `portabilityDir` 时，服务直接拒绝加载。

支持的字段见[配置目录](../../../docs/config-catalog.zh.md)。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>Implementation internals — click to expand</summary>

`remember` 保存含来源和可选过期时间的显式事实。完全重复的内容复用已有记录。`updateMemory` 增加版本号；显式 `supersedes` 使旧事实失效。`forget` 仅删除有权限的记忆并重新检查主存储，记忆操作不能删除源文件片段。

[`portability.ts`](src/portability.ts) 定义导出信封、遗忘账本和导入日志；[`portability-ops.ts`](src/portability-ops.ts) 决定它们的写入次序。读写共用同一版本 `MEMORY_EXPORT_VERSION`，记忆的每个存储字段按固定顺序序列化，因此新增记录字段在格式纳入前无法通过编译。导出只携带已提交的记录：读取前先完成未竟的替代写入，解码时拒绝待处理行。导入把接受的文本重新嵌入当前挂载存储的空间，按存储路径写入以写前日志暂存，校验逐字节回读以及一条生效记录和一条失效记录的可检索性，之后才发布。失败的批次会被删除，原存储从不以写入方式打开；被中断的日志会在该存储下一次导入规划前清除。准入判定拒绝账本已遗忘的 ID、外部所有者、已保存不同内容的 ID 以及超出 `maxMemories` 的记录，并逐条报告原因。过期或被替代记录保持原状态，不会因导入而可检索。 操作者命名的文件逐段解析并跟随文件系统链接，因此经链接离开 `portabilityDir` 的名称在任何读写之前即被拒绝。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [检索包组](../README.zh.md) — 选择包。
- [本地检索指南](../../../docs/user/guide/local-retrieval.zh.md) — 设置、恢复和隐私。
- [检索子系统](../../../docs/subsystems/retrieval.zh.md) — 服务职责。

<a id="model-experience"></a>
## Model Experience

间接通过 `dsh-retrieval-tools` 产生影响；该包负责工具结果和自动上下文。

#### KV Cache effect

不会直接增加请求 token 或改变缓存；上下文增长由消费方记录的结果决定。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- 矛盾事实需要显式更新或替代；模型不会静默改写事实。
- 共享本地主体并不构成多用户认证。请为不同用户使用独立操作系统账户和 Harness 主目录。
- 工作区和会话索引是派生数据；显式记忆保存在权威存储中，更换嵌入空间前必须备份，随后把导出文件导入新存储。
- 可迁移功能只搬运显式记忆。源片段依靠重建配置的文件与获授权会话得到，且单次导出受 `maxPortabilityRecords` 限制。
- 遗忘账本是 `portabilityDir` 下的本机状态。删除之前制作的存储备份，或导入到另一个 `portabilityDir`，仍可能重新引入该事实。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

[记忆可迁移格式 Agent Note](../../../.agents/notes/implemented/feature/2026-11-02-memory-portability-format.zh.md)记录了账本条目为何先于删除写入、待处理记录为何不能导出，以及导入为何重新嵌入而不是复制向量。[portability.spec.ts](tests/portability.spec.ts) 校验格式、文件路径和账本规则；[portability-ops.spec.ts](tests/portability-ops.spec.ts) 通过覆写 `PortabilityHost` 覆盖全部次序分支。

</details>
