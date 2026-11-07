# Agent Note: 神经检索证据类别

Status: implemented

[English](2026-11-02-neural-retrieval-evidence-classes.md) | 中文

## 问题

神经嵌入质量需要证据，但测量宿主既没有提供方密钥，也没有可达的本地嵌入端点。如果框架为一个从未接触模型的路径报告分数，传输检查就变成了语义质量声明，后续读者无法区分两者。据此更改嵌入默认值，比保持原状更糟。

## 决策

[神经相关性框架](../../../../benchmarks/context-retrieval/neural/run.mjs)为每个路径结果标记一种证据类别：无需模型即可运行的提供方记为 `lexical-baseline`，通过配置端点由真实权重服务的路径记为 `neural-model`，`--selftest=true` 记为 `harness-plumbing`，后者通过相同的 OpenAI 兼容传输返回 token 摘要向量。只有 `neural-model` 会设置 `neuralQualityValidated`。端点探测失败的路径记录在 `report.pending`，附带探测错误和可以清除它的确切命令，本次运行状态为 `partial-pending-live-neural-endpoint` 而不是通过。

[neural/cases.ts](../../../../benchmarks/context-retrieval/neural/cases.ts) 中的质量目标在测量前声明，其中包含更改默认值所需的差距。未达成的目标保留在 `targetVerdicts` 中；2026-11-02 运行的多语言与缺失证据未达标项被保留。Zvec 仍是权威存储，turbovec 仍可选，`local-hashed` 仍是默认提供方。

## 考虑过的替代方案

把自检替代服务的结果报告为稠密路径质量——已否决：它验证请求封装、维度一致、嵌入空间标识和上下文打包，不验证改写检索。要求先有可用端点再落地任何内容——已否决：确定性的框架、固定配方和扩展的真实模型套件本身就有价值，也让补上缺失测量变得廉价。把预声明目标放宽到实测值——已否决：目标存在的意义正是提供比较基准，放宽会销毁它。

## 后果

神经相关性仍是一项可由操作者运行的测量，而不是仓库内的声明；固定配方加 `modelRevision` 使复现运行可比。只有类别为 `neural-model` 且达成声明差距的运行才能改变嵌入提供方默认值。`modelRevision` 必须与实际提供服务的权重一致，因为嵌入空间键包含提供方、模型、维度、归一化、端点和版本；权重被静默替换后会把不再属于同一空间的向量混用。真实模型 E2E 用例在没有 `DEEPSEEK_API_KEY` 时自动跳过，因此 CI 的沉默不等于验证；[权威存储决策记录](2026-11-01-authoritative-local-retrieval.zh.md)仍然规定 Zvec 与 turbovec 各自可以持有什么。
