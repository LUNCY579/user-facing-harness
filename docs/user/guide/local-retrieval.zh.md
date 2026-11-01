# 本地上下文检索与显式记忆

[English](local-retrieval.md) | 中文

## Summary

无需数据库服务或云嵌入账户即可启用本地源码搜索和显式记忆。默认哈希嵌入提供方采用确定性的词法特征哈希，并非训练得到的语义模型。需要改写语义检索时，请配置自己控制的本地嵌入服务。正式基础配置默认禁用所有检索插件。

## Table of Contents

- [Enable and verify](#enable-and-verify)
- [Call the tools](#call-the-tools)
- [Choose memory ownership](#choose-memory-ownership)
- [Choose embeddings and acceleration](#choose-embeddings-and-acceleration)
- [Recover or disable](#recover-or-disable)
- [Privacy and verification limits](#privacy-and-verification-limits)
- [Dev Note](#dev-note)

## Enable and verify

先使用 Node 24.9 或更新版本完成[仓库安装](../../../README.zh.md#run-from-source)。在仓库根目录通过可选配置启动组合应用：

```sh
pnpm start --patch "$PWD/apps/cli/config/examples/retrieval.yml"
```

[配置示例](../../../apps/cli/config/examples/retrieval.yml)以启动目录作为索引根目录。请在会话中选择同一目录作为工作区。索引其他项目时，复制该配置，并将 `retrieval-indexing.config.roots` 改为该项目原始工作区内选定的绝对目录。不要覆盖已有私有配置而丢失其他条目。

选择可用且支持工具的模型。让它以 `{"source":"workspace"}` 调用 `context_index`，再用某个已索引文件中的符号和 `mode: "keyword"` 调用 `workspace_semantic_search`。成功结果包含原始路径、行范围、源码文本和检索分数。`memory_status` 报告嵌入空间与后端健康状态。搜索不会触发文件扫描；编辑、重命名或删除文件后应再次索引。

运行时状态位于配置所用的 Harness 主目录：组合启动器默认使用已忽略的 `.testingplatform/`，也可以使用配置的 `DSH_HOME`。示例将检索数据保存在该主目录下。不要将嵌入、记忆或私有源文档加入 Git。

## Call the tools

以下名称是模型可调用的工具，也可通过普通 PTC 工具桥使用。完整 schema 以[生成目录](../../tool-catalog.zh.md#deepseek-aidsh-retrieval-tools)为准。

| 工具 | 用途 |
|---|---|
| `context_index` | 同步工作区文件或获授权的工作区会话；重建来源派生索引 |
| `context_search` | 对允许访问的来源文本和记忆执行混合检索 |
| `workspace_semantic_search` | 带源引用的工作区关键词、稠密向量或混合搜索 |
| `vector_similarity_search` | 稠密向量最近邻检索 |
| `memory_search` | 查询记忆，或不带查询列出记忆 |
| `memory_remember` | 显式保存指定作用域的事实，可附标签和过期时间 |
| `memory_update` | 用返回的 ID 修正记忆，并递增版本 |
| `memory_forget` | 删除获授权的 ID、过期记忆或选定记忆作用域 |
| `memory_status` | 检查本地存储、嵌入和加速器健康状态 |

可以用合成工作流验证：让代理在 `workspace` 作用域记住 `Synthetic project review day is Tuesday`，保存返回的 ID。在同一工作区开启新会话并搜索 `project review day`。用 `memory_update` 将该 ID 修正为 Thursday，再次搜索。只有修正后的存储值是当前值。最后用该 ID 调用 `memory_forget`；重启后再次搜索，确认它不可见。

列出记忆无需查询文本。使用 `scopes` 可以缩小列表。创建时的 `ttl_days` 设置有效期；过期条目不再参与检索，但会一直保存到匹配的遗忘清理。`memory_update` 接受 `expires_at: null` 以清除有效期。完全重复的内容复用同一记忆；矛盾事实须通过显式修正或替代处理。

自动上下文须单独启用：在复制的配置中设置 `retrieval-tools.config.autoRetrieval: true`。它需要基础配置的 `sessionQuery` 服务。默认对不少于 24 个字符的查询选择最多四段相关度超过 `autoMinScore: 0.35` 的文本，总估算 token 不超过 `autoBudgetTokens: 600`。会话中已提交且未变化的选定证据集合不会因排序或分数变化而再次注入。新内容或记忆版本可以产生新的日志消息。自动去重会异步读取并扫描会话日志，因此长日志会增加读取和扫描成本。

## Choose memory ownership

创建记忆必须指定作用域。身份与权限由宿主提供；模型生成的用户、工作区或会话 ID 不能授予访问权。

| 作用域 | 可检索者 |
|---|---|
| `workspace` | 原始工作区内配置的本地主体 |
| `session` | 同一主体与会话；同工作区的其他会话需要 `crossSessionRead: true` |
| `agent` | 同一主体、工作区和代理 |
| `user` | 跨工作区的同一配置主体，且必须启用 `persistentMemory: true` |

示例关闭个人持久保存和跨会话记录访问。显式工作区记忆本身已支持同工作区新会话回忆。只有希望保留用户级事实时才启用个人持久保存。没有组件会从所有对话中静默提取个人事实。会话文本索引还需要 `retrieval-indexing.config.indexSessions: true`，以及 `source: "sessions"` 的显式 `context_index` 调用；其范围是获授权的活动和持久工作区会话。

`localPrincipal` 默认为操作系统用户名。它是可信的本地配置标签，不是多浏览器用户认证系统。原始本地会话日志视为属于该操作者；此标签不能在共享的多用户日志存储中确立所有权。打开会话时请使用规范化工作区路径；会拒绝符号链接别名，防止重启后重新指向其他权限对象。会话内切换工作目录不会授予其他工作区的记忆访问权。

## Choose embeddings and acceleration

创建索引前先选择提供方。嵌入提供方、模型、端点标识、权重版本、归一化方式和维度共同决定向量兼容性。不匹配会明确报错，而不会混合不同空间。服务中同一模型 ID 可能对应替换后的权重时，请设置 `modelRevision`。

- `local-hashed` 无需网络或下载模型权重即可使用，适合确定性的关键词导向检索和基准测试。
- `local-openai-compatible` 仅向配置的回环 HTTP(S) 嵌入端点发送文本。请自行启动并配置本地嵌入运行时，并匹配其模型 ID 与输出维度。TestingPlatform 不安装模型权重。
- `openai-compatible` 需要 `allowRemoteEmbeddings: true`，并从配置的 `apiKeyEnv` 读取凭据。启用它即授权向该提供方发送索引文本和查询。除非文档所有者明确同意上传，否则应保持关闭。

[嵌入包](../../../packages/retrieval/retrieval-embed/README.zh.md)定义提供方字段与传输限制。本地 HTTP 行为使用合成数据测试；此处不声称已验证云嵌入提供方或真实神经模型。

Zvec 可以独立运行，也是默认选择。实验 turbovec 时，可使用 Python 3.11 或更新版本，在忽略的环境内安装经过测试的可选工作进程依赖（本地使用 Python 3.12.6 验证）：

```sh
python3 -m venv .testingplatform/retrieval-python
.testingplatform/retrieval-python/bin/python -m pip install turbovec==1.1.2 numpy==2.3.5
```

在复制的配置中设置 `retrieval-zvec.config.acceleratorEnabled: true`，将 `turbovecPython` 指向该环境中 Python 的绝对路径，并设置 `retrieval.config.useAccelerator: true`。默认使用四位压缩；两位压缩属于实验功能。工作进程是可重建的稠密重排器，不是独立持久记忆库。缺失或失败的工作进程会回退到获授权的 Zvec 检索。为工作负载启用加速前，请阅读[本地基准报告](../../../benchmarks/context-retrieval/README.zh.md)。

## Recover or disable

根据报告的操作和错误代码选择恢复方式。复制或恢复索引目录时应停止应用。

| 情况 | 操作 |
|---|---|
| 文件发生变化或消失 | 以 `source: "workspace"` 调用 `context_index`；哈希识别重复或变化的内容 |
| 来源索引过期，或派生账本损坏 | 以 `source: "rebuild"` 调用 `context_index`；清除并重建获授权的来源段落，保留显式记忆 |
| 记忆写入报告 `outcome_pending` | 检查 `memory_status`；以 `source: "rebuild"` 调用 `context_index`，完成获授权的暂存修改后再继续依赖操作 |
| 嵌入模型、权重、端点或维度改变 | 备份旧索引；选择新的 `indexDir` 与 `statePath` 后重新索引；显式记忆须手动迁移 |
| 权威 Zvec 集合损坏 | 停止应用并恢复可靠备份；来源重建不能修复丢失的显式记忆 |
| turbovec 不可用 | 使用 Zvec；检查 `memory_status`，修正工作进程路径或依赖后再重启 |
| 删除记忆 | 用 ID 或获授权的作用域调用 `memory_forget`；会验证权威存储中的删除结果 |
| 暂时隐藏工具 | 设置 `retrieval-tools.config.enableTools: false`，同时关闭自动检索 |
| 禁用子系统 | 不加载可选配置，或在配置中禁用全部五个检索条目 |

重建会重新读取配置的文件以及可通过 Session 持久化服务访问的获授权工作区会话；它无法恢复不可用的源日志，或已从权威存储删除的显式记忆。嵌入空间变化不会自动迁移记忆。请保护旧备份：其中仍可能包含被遗忘的事实。

## Privacy and verification limits

索引器默认排除常见秘密文件、凭据、生成目录、运行时状态及 `.git`，并拒绝路径穿越和符号链接逃逸。这些排除规则无法识别粘贴在普通源文件中的秘密：请谨慎选择索引根目录。检索文本是不可信证据，永远不会成为系统指令。

遗忘会移除可搜索记录，并阻止过期加速器 ID 再次返回它们。它不会抹除历史 Session 工具结果、文件系统历史、备份或可恢复存储块。显式索引的记录和文件仍可能独立于已删除记忆 ID 包含相同事实。请使用各原始系统的保留控制处理这些副本。

[无密钥 headless 记录](../../../snapshots/session/local-retrieval/snapshot.yml)通过正式配置验证带源链接的索引与检索。[真实 Loader 工作流](../../../packages/retrieval/retrieval-tools/tests/composition.spec.ts)使用本地脚本模型验证合成的跨会话回忆、修正、重启后仍有效的删除、工作进程回退以及同存储工作区隔离。这些测试确认工具编排，而非真实模型的任务准确率。索引器要求会话文件系统映射到相同的原生宿主目录；会拒绝 SSH 和不相关的执行环境。本地仅执行了 macOS arm64 原生验证；该集成适合本地实验，尚不能据此认定可用于多用户生产部署。

## Dev Note

无。
