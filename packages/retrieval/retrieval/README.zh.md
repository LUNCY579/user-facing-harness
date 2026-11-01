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
```

`enabled` 控制全部操作。`maxTextChars`、`maxTopK` 和 `maxPendingWrites` 限制输入、结果和写入队列。`maxMemories` 统计所有保留的记忆，包括已过期和被替代的记录。记忆查询在评分前执行由宿主解析的主体、工作区、会话和智能体权限；模型参数无法选择身份。

支持的字段见[配置目录](../../../docs/config-catalog.zh.md)。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>Implementation internals — click to expand</summary>

`remember` 保存含来源和可选过期时间的显式事实。完全重复的内容复用已有记录。`updateMemory` 增加版本号；显式 `supersedes` 使旧事实失效。`forget` 仅删除有权限的记忆并重新检查主存储，记忆操作不能删除源文件片段。

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
- 工作区和会话索引是派生数据；显式记忆保存在 Zvec 中，更换嵌入空间前必须备份。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
