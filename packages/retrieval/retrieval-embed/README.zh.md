---
description: "选择确定性的离线哈希、本地嵌入模型端点或显式授权的远程嵌入。"
kind: "package-reference"
---

# @deepseek-ai/dsh-retrieval-embed

[English](README.md) | 中文

## 概述

生成归一化向量，无需云服务。默认特征哈希无需下载模型，衡量的是词项重叠。本地 OpenAI 兼容嵌入端点可提供神经语义检索；远程提供方必须显式授权。

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
- name: '@deepseek-ai/dsh-retrieval-embed'
  config:
    provider: local-hashed
    model: dsh-hashed-v1
    dimension: 256
```

`local-openai-compatible` 要求回环地址 `baseUrl` 和已安装模型的准确 `model` 名称，不会下载权重。`openai-compatible` 要求 `allowRemoteEmbeddings: true`。两者均拒绝重定向、验证响应维度与有限数值、限制响应字节，并遵循取消和请求截止时间。`apiKeyEnv` 默认为空：未指定凭据变量时，本地端点不会收到令牌；远程提供方必须显式配置变量并提供对应凭据。卸载会取消 HTTP 请求和重试等待，并等待它们结束。

支持的字段见[配置目录](../../../docs/config-catalog.zh.md)。

-----

<a id="understand-the-implementation"></a>
## 了解实现

<details>
<summary>Implementation internals — click to expand</summary>

提供方、端点标识、模型、模型修订、维度和归一化方式共同标识嵌入空间。更换空间需要独立索引目录和显式记忆迁移，不同空间的向量不会混用。在相同端点和模型名称后更换权重时，请设置 `modelRevision`。`maxBatch` 限制请求批次，本地哈希在批次之间让出执行时间。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [检索包组](../README.zh.md) — 选择包。
- [本地检索指南](../../../docs/user/guide/local-retrieval.zh.md) — 设置、恢复和隐私。
- [检索子系统](../../../docs/subsystems/retrieval.zh.md) — 服务职责。

<a id="model-experience"></a>
## Model Experience

无，因为嵌入向量不会进入会话请求。

#### KV Cache effect

不会直接影响会话缓存。远程嵌入请求是发往所配置端点的独立请求。

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- 哈希属于词项检索，不具备学习得到的语义理解能力。
- 神经检索质量取决于运维者安装的嵌入模型和服务；不附带模型权重。
- 授权远程提供方会将查询和索引文本上传到该提供方。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
