---
description: "使用合成数据复现本地检索延迟、召回率、进程内存和上下文打包测量。"
---

# 上下文检索基准

[English](README.md) | 中文

## 摘要

对生成的源码、文档、会话和记忆文本，比较词项搜索、Zvec、真实四位/两位 turbovec、组合重排器和混合检索。运行器在独立进程中执行构建后的 JavaScript 并保存原始 JSON。这是没有 CI 时间阈值的可选诊断；[报告](report/README.zh.md)记录本地结果和限制。

## 目录

- [运行对比](#run-the-comparison)
- [测量神经相关性](#measure-neural-relevance)
- [测量终点](#measurement-endpoints)
- [复现打包对照](#reproduce-the-packing-control)
- [限制](#limits)
- [开发备注](#dev-note)

<a id="run-the-comparison"></a>
## 运行对比

使用 Node 24.9+、固定版本 pnpm，以及具有 `ps` 和 `rg` 的 POSIX 宿主。监督进程支持 macOS、Linux 和 WSL，尚未实现原生 Windows 监督。按照[检索指南](../../docs/user/guide/local-retrieval.zh.md)安装可选工作进程。从仓库根目录运行：

```sh
pnpm install --frozen-lockfile
pnpm run setup
pnpm exec tsdown --config-loader native --config benchmarks/tsdown.config.ts
pnpm run bench:retrieval --sizes=1000,10000,100000 --queries=64 --python="$PWD/.testingplatform/retrieval-python/bin/python"
```

全部文本由经过审查的常量和种子 421337 生成，不读取工作区、会话、凭证或外部模型。监督进程和工作进程拥有并清理临时语料和索引目录。默认输出为忽略的 `.testingplatform/retrieval-benchmark/results.json`；`--output=...` 可选择其他私有结果文件。缺失 turbovec 会明确记录为跳过。

可用 `--modes=ann-sweep --sizes=100000` 运行匹配调优诊断，或用 `--modes=zvec,combined`、`--runs=3`、`--queries=100` 或 `--dimension=256` 缩小或重复对比。压缩要求维度可被八整除。运行器最多允许一百万个向量，但受原生枚举限制和可用内存约束；本地验证不包含该规模。

<a id="measure-neural-relevance"></a>
## 测量神经相关性

`bench:retrieval:neural` 在 35 条合成片段和 45 个查询上为关键词、特征哈希稠密、神经稠密和混合路径打分，查询分为改写、困难负例、标识符、多语言和缺失证据五类。所有质量目标在测量前声明于 [neural/cases.ts](neural/cases.ts)，未达到目标的路径记录为失败目标，而不是放宽目标。

```sh
pnpm exec tsdown --config-loader native --config benchmarks/tsdown.config.ts
pnpm run bench:retrieval:neural --baseUrl=http://127.0.0.1:11434/v1
```

监督进程在建立索引前探测 `GET <baseUrl>/models`，且从不发送凭据。端点不可达时，稠密和混合路径连同探测错误保留在 `pending` 中，本次运行报告 `partial-pending-live-neural-endpoint`；只有词项路径报告为已测量。`--selftest=true` 使用基于 token 摘要的替代服务，使稠密和混合代码路径在没有模型的情况下实际执行，并把该证据标记为 `harness-plumbing`，绝不标记为 `neural-model`。固定模型配方见[神经嵌入指南](../../docs/user/guide/local-neural-embeddings.zh.md)。默认输出为忽略的 `.testingplatform/retrieval-benchmark/neural.json`。

<a id="measurement-endpoints"></a>
## 测量终点

对比使用一个调用者、一个查询线程、一个建索引线程、256 维归一化特征哈希、256 条记录的批次和相同的 64 个查询前缀。初始矩阵固定使用旧设置 `hnswEf: 64`；`ann-sweep` 在同一不变索引上测量受支持的搜索深度范围和成对路径。完成该扫描后，产品默认值为 2048。每个查询都有一个已知源记录；精确 float32 余弦搜索提供稠密排序基准。所有索引记录都由基准主体授权；对抗性作用域检查属于功能测试。

| 测量 | 包含的操作 |
|---|---|
| 创建 | 文本嵌入、主存储写入或压缩副本、原生优化；同时保存各阶段数据 |
| 热查询 | 按标记分别测量 `rg` 进程、原生 Zvec 查询、完整白名单压缩查询或组合服务查询 |
| 上下文 | 包含查询嵌入、授权、去重和估算 token 打包的统一检索 |
| 冷激活 | 保留操作系统页缓存的重新打开及首次查询；独立 turbovec 还会重建临时副本 |
| 增量 | 权威存储模式替换百分之一记录并包含嵌入；不含文件系统发现。基线只测量真值嵌入，不更新词项文件 |
| 召回率和 MRR | Recall@1/5/10 及精确最近结果的倒数排名；另列目标源命中率 |
| CPU 和内存 | Node CPU/RSS，以及每 100 毫秒采样的完整子进程树 CPU/RSS；共享页可能被重复计数 |
| IPC | 十六次活跃工作进程状态往返，是消息封装与分派的下界，不是搜索内核时间 |

所有模式在诊断进程中保留共同的精确搜索矩阵。基线嵌入时间和该矩阵属于基准参考开销，并非词项检索的要求。原始查询终点的能力不同；判断组合路径时应比较上下文服务列。顺序批查询吞吐量使用并发一。

<a id="reproduce-the-packing-control"></a>
## 复现打包对照

`packing` 对固定授权候选重复调用生产 `pack()`。优化在每次操作中只为每个片段准备一次 token 集合。反向对照补丁恢复重复分词，而不改变输出片段。应用前保存所属源码，完成后恢复：

```sh
git apply benchmarks/context-retrieval/packing-negative-control.patch
pnpm run build:artifacts
pnpm run bench:retrieval --sizes=40,100 --modes=packing --runs=3 --queries=100 --output=.testingplatform/retrieval-benchmark/packing-before.json
git apply -R benchmarks/context-retrieval/packing-negative-control.patch
pnpm run build:artifacts
pnpm run bench:retrieval --sizes=40,100 --modes=packing --runs=3 --queries=100 --output=.testingplatform/retrieval-benchmark/packing-after.json
```

比较所有输出哈希和原始样本。如果输出改变，测得的提速无效。计时期间停止其他高 CPU 构建和测试。

<a id="limits"></a>
## 限制

这些夹具测量特征哈希排序、存储和 IPC 开销，而非语言理解或真实模型任务准确率。token 数是估算值。在本地嵌入端点和模型密钥可用之前，神经相关性验证和真实模型验证保持待完成状态；框架把它们记录为待完成，而不是通过。这些结果不能证明多用户生产就绪、跨平台矩阵、等召回提速、稳定总体 p99 或物理安全擦除。

<a id="dev-note"></a>
## 开发备注

[决策记录](../../.agents/notes/implemented/architecture/2026-11-01-authoritative-local-retrieval.zh.md)保存存储和恢复依据。
