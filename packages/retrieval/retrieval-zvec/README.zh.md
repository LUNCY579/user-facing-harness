---
description: "在 Zvec 中持久保存授权检索记录，并可选用隔离的 turbovec 工作进程重排稠密向量候选。"
kind: "package-reference"
---

# @deepseek-ai/dsh-retrieval-zvec

[English](README.md) | 中文

## 概述

将记录、元数据、稠密向量和全文索引保留在本机。Zvec 无需数据库服务即可提供关键词、余弦和混合检索。四位 turbovec 工作进程仅用于可选实验；Zvec 始终是回退路径和记忆主存储。

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
- name: '@deepseek-ai/dsh-retrieval-zvec'
  config:
    indexDir: .testingplatform/retrieval
    queryThreads: 1
    optimizeThreads: 1
    acceleratorEnabled: false
```

`enableMMAP` 默认为 true。根据[基准报告](../../../benchmarks/context-retrieval/report/README.zh.md)中实测的高召回设置，`hnswEf` 默认采用原生上限 2048。HNSW 和全文索引使用同一集合。原生过滤器在评分前执行主体和作用域权限。操作系统支持的独占写租约阻止并发写入，并在进程退出时释放。

支持的字段见[配置目录](../../../docs/config-catalog.zh.md)。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>Implementation internals — click to expand</summary>

`acceleratorEnabled` 通过 `turbovecPython` 挂载真实 turbovec；`acceleratorBitWidth` 默认 4，2 位属于实验选项。工作进程通过私有标准输入输出接收有界 JSON，不继承凭证，并在原生内核中按授权 ID 过滤。重启后派生索引为空；缺失或无效候选会安全回退到 Zvec。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [检索包组](../README.zh.md) — 选择包。
- [本地检索指南](../../../docs/user/guide/local-retrieval.zh.md) — 设置、恢复和隐私。
- [检索子系统](../../../docs/subsystems/retrieval.zh.md) — 服务职责。

<a id="model-experience"></a>
## Model Experience

间接通过 `dsh-retrieval-tools` 产生影响；该包负责呈现存储证据。

#### KV Cache effect

不会直接影响会话缓存。仅当消费方提供搜索结果时才改变上下文。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- 本地仅验证 macOS arm64；其他平台的可用性取决于上游 wheel 和 Node 绑定。
- turbovec 是临时压缩重排器，不是独立持久记忆数据库，其副本不会减少主 Zvec 存储。
- 遗忘会删除可检索记录，但不会删除历史会话工具消息、备份或可恢复的文件系统块。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
