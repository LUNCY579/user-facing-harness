# 本地神经嵌入

[English](local-neural-embeddings.md) | 中文

## 概述

让释义级检索完全在你自己的机器上运行。本方案固定 BAAI/bge-m3 权重，通过只监听回环地址的 OpenAI 兼容端点提供服务，并把已有的 `local-openai-compatible` 提供方指向该端点。不涉及新的嵌入抽象，文本也不会离开本机。评判结果的检索质量工具位于 [benchmarks/context-retrieval/neural](../../../benchmarks/context-retrieval/neural/)。

## 目录

- [前提条件](#prerequisites)
- [安装并提供固定模型](#install-and-serve-the-pinned-model)
- [让检索指向该端点](#point-retrieval-at-the-endpoint)
- [校验向量空间](#verify-the-space)
- [测量检索质量](#measure-relevance)
- [限制](#limits)

<a id="prerequisites"></a>
## 前提条件

需要 Node 24.9 或更高版本、[README](../../../README.zh.md#run-from-source) 中的仓库环境，以及足以运行一个 5.67 亿参数编码器的空闲内存。以下事实已对照上游核实：BAAI/bge-m3 采用 MIT 许可，输出 1024 维稠密向量，单次输入最长 8192 个 token，覆盖 100 多种语言，且查询无需附加指令前缀。其 Hugging Face 版本号为 `5617a9f61b028005a4858fdac845db406aefb181`；Ollama 包为 `bge-m3:567m`，约 1.2 GB。

<a id="install-and-serve-the-pinned-model"></a>
## 安装并提供固定模型

安装一个暴露 `POST /v1/embeddings` 的嵌入运行时，让它只绑定回环地址，然后拉取固定的标签：

```sh
ollama pull bge-m3:567m
ollama serve
curl -s http://127.0.0.1:11434/v1/models
```

该端点接受 `model`、以字符串或字符串数组形式的 `input`，以及 `dimensions`。它不支持以 token 数组形式传入 `input`，因此批量只发生在文本层面。

<a id="point-retrieval-at-the-endpoint"></a>
## 让检索指向该端点

复制 [神经嵌入覆盖文件](../../../apps/cli/config/examples/retrieval-neural.yml) 后用它启动。示例设置 `provider: local-openai-compatible`、`model: bge-m3:567m`、`dimension: 1024`、`baseUrl: http://127.0.0.1:11434/v1`，并固定 `modelRevision`。它还选择了全新的 `indexDir` 和 `statePath`，因为已有索引属于另一个向量空间，而存储拒绝混合不同空间。

```sh
pnpm start --patch "$PWD/apps/cli/config/examples/retrieval-neural.yml"
```

`maxBatch` 限定单个请求体大小。`timeoutMs` 限定截止时间。`apiKeyEnv` 保持为空：回环端点不需要凭据，也不会附带环境中的 `OPENAI_API_KEY`。

<a id="verify-the-space"></a>
## 校验向量空间

让具备工具能力的模型先调用 `memory_status`，再用 `source: "workspace"` 调用 `context_index`，然后用某句已索引文本的释义以及 `mode: "semantic"` 调用 `workspace_semantic_search`。`memory_status` 会报告向量空间与后端健康状态。维度或版本不匹配会在加载时以 `space_mismatch` 失败，而不会跨空间比较向量。

<a id="measure-relevance"></a>
## 测量检索质量

在仓库根目录编译被测 worker 并运行对比：

```sh
pnpm exec tsdown --config-loader native --config benchmarks/tsdown.config.ts
pnpm run bench:retrieval:neural --output=.testingplatform/retrieval-neural/results.json
```

运行器先探测端点。若端点可达，它在完全相同的查询设置下对同一合成语料测量 `keyword`、`hashed`、`dense`、`hybrid` 四条路线，并记录相关性、引用有效性、时延、进程内存、模型与运行时版本，以及每一项未达标的目标。若端点不可达，它仍测量两条词法路线，把神经路线连同探测错误一起记为待验证，并且不会编造数字。`--selftest=true` 会启动一个确定性的回环替代服务，它只是对 token 摘要做算术；用于证明整条流水线可用，其结果标记为 `harness-plumbing`，绝不作为神经证据。

<a id="limits"></a>
## 限制

语料与查询都是预先撰写的常量，因此分数只用于比较各路线的相对强弱，并不能预测你的实际负载。质量目标在测量之前就已写入 [cases.ts](../../../benchmarks/context-retrieval/neural/cases.ts)；未达标的记录会保留。Zvec 仍是默认的持久存储，turbovec 仍是可选启用——本仓库尚无实测证据支持改动其中任何一项。更换提供方或版本需要全新的 `indexDir` 并重建索引；显式记忆的迁移需要专门处理。作用域、恢复与隐私由[检索指南](local-retrieval.zh.md)负责说明。
