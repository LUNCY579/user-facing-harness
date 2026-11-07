# 本地上下文检索与显式记忆

[English](local-retrieval.md) | 中文

## Summary

无需数据库服务或云嵌入账户即可启用本地源码搜索和显式记忆。默认哈希嵌入提供方采用确定性的词法特征哈希，并非训练得到的语义模型。需要改写语义检索时，请配置自己控制的本地嵌入服务。正式基础配置默认禁用所有检索插件。

## Table of Contents

- [Enable and verify](#enable-and-verify)
- [Call the tools](#call-the-tools)
- [Choose memory ownership](#choose-memory-ownership)
- [Choose embeddings and acceleration](#choose-embeddings-and-acceleration)
- [Move memories between stores](#move-memories-between-stores)
- [Platform support](#platform-support)
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

`localPrincipal` 默认取运行 harness 的账户名；当宿主没有该 uid 的账户记录时，依次回退到 `USER`、`USERNAME`，再到 `uid-<数字>`。它是可信的本地配置标签，不是多浏览器用户认证系统。原始本地会话日志视为属于该操作者；此标签不能在共享的多用户日志存储中确立所有权。打开会话时请使用规范化工作区路径；会拒绝符号链接别名，防止重启后重新指向其他权限对象。会话内切换工作目录不会授予其他工作区的记忆访问权。

## Choose embeddings and acceleration

创建索引前先选择提供方。嵌入提供方、模型、端点标识、权重版本、归一化方式和维度共同决定向量兼容性。不匹配会明确报错，而不会混合不同空间。服务中同一模型 ID 可能对应替换后的权重时，请设置 `modelRevision`。

- `local-hashed` 无需网络或下载模型权重即可使用，适合确定性的关键词导向检索和基准测试。
- `local-openai-compatible` 仅向配置的回环 HTTP(S) 嵌入端点发送文本。请自行启动并配置本地嵌入运行时，并匹配其模型 ID 与输出维度。TestingPlatform 不安装模型权重。
- `openai-compatible` 需要 `allowRemoteEmbeddings: true`，并从配置的 `apiKeyEnv` 读取凭据。启用它即授权向该提供方发送索引文本和查询。除非文档所有者明确同意上传，否则应保持关闭。

[嵌入包](../../../packages/retrieval/retrieval-embed/README.zh.md)定义提供方字段与传输限制。本地 HTTP 行为使用合成数据测试；此处不声称已验证云嵌入提供方或真实神经模型。[神经嵌入指南](local-neural-embeddings.zh.md)固定了一套可复现的本地配方，并链接用于评分的[相关性框架](../../../benchmarks/context-retrieval/neural/run.mjs)。

Zvec 可以独立运行，也是默认选择。实验 turbovec 时，可使用 Python 3.11 或更新版本，在忽略的环境内安装经过测试的可选工作进程依赖（本地使用 Python 3.12.6 验证）：

```sh
python3 -m venv .testingplatform/retrieval-python
.testingplatform/retrieval-python/bin/python -m pip install turbovec==1.1.2 numpy==2.3.5
```

在复制的配置中设置 `retrieval-zvec.config.acceleratorEnabled: true`，将 `turbovecPython` 指向该环境中 Python 的绝对路径，并设置 `retrieval.config.useAccelerator: true`。默认使用四位压缩；两位压缩属于实验功能。工作进程是可重建的稠密重排器，不是独立持久记忆库。缺失或失败的工作进程会回退到获授权的 Zvec 检索。为工作负载启用加速前，请阅读[本地基准报告](../../../benchmarks/context-retrieval/README.zh.md)。

## Move memories between stores

设置 `retrieval.config.portabilityEnabled: true`，并把 `retrieval.config.portabilityDir` 指向仓库之外的绝对目录，例如配置主目录下的某个目录。导出文件、遗忘账本和导入日志都是该目录下的明文记忆文本。无论是用 `..` 还是通过链接指向该目录之外的文件名，都会在任何读写之前被拒绝。文件格式及其写入次序由[检索服务包](../../../packages/retrieval/retrieval/README.zh.md)定义。

在拥有记忆的那个工作区会话中运行 `/memory-export <file-name>`。它导出配置的 `localPrincipal` 可读记录，并在导出前完成未竟的替代写入。加上 `--include-inactive` 会一并导出过期和被替代记录，使目标存储保留生命周期历史。`/memory-import <file-name>` 会把文件重新嵌入当前存储，并报告接受、已存在、恢复和拒绝数量，逐条给出被拒绝记录的 ID 与原因。

导入只有在接收宿主有权写入的身份下才会接受记录，因此迁移时请打开原始规范化工作区并使用相同的 `localPrincipal` 值。属于其他工作区或主体的记录会被拒绝而不是改写，所有权在导入过程中从不改变。

更换嵌入提供方、模型、端点、权重版本、归一化方式或维度时，应选择导入而非仅重建索引。先备份旧索引，把 `indexDir` 与 `statePath` 指向新目录，使用新提供方重启，再运行一次 `/memory-import`。向量由已存储文本在目标空间重新生成，因此源存储不会被打开写入。

若某 ID 已被本机记入遗忘账本，导入会拒绝它，直到操作者主动删除该账本条目；若某 ID 已保存不同内容，同样拒绝。过期或被替代的记录绝不会因导入而重新可检索。写入或校验失败会精确删除本批暂存记录；被中断的导入留下的记录会在该存储下一次导入规划前被清除。

## Platform support

原生检索需要对应平台的 Zvec 绑定；可选加速器还需要同一平台的 turbovec Python wheel。在 `pnpm run build:artifacts` 之后运行 `pnpm run check:native-retrieval` 就能在本机验证：该通道驱动真实绑定，再通过已发布的 `lib` 入口打开集合，回答一次语义查询和一次关键词查询，在重新打开后仍然可用，排除其他工作区，并执行限定范围的遗忘。它无需密钥且有边界，会在意外跳过、套件无法加载或缺少绑定时判为失败。可用性依据 `@zvec/zvec` 0.8.0 与 `turbovec` 1.1.2 已发布的包列表确认。

| 平台 | Zvec 绑定 | turbovec wheel | 验证情况 |
|---|---|---|---|
| linux-x64 | 可用 | `manylinux_2_28_x86_64` | 已定义必需通道，另有提供 turbovec 工作进程的通道；托管执行结果待补 |
| linux-arm64 | 可用 | `manylinux_2_28_aarch64` | 已定义必需通道；托管执行结果待补 |
| darwin-arm64 | 可用 | `macosx_11_0_arm64` | 已在本机执行通道，分别在不提供和提供工作进程时验证；没有托管 macOS 运行器 |
| darwin-x64 | 可用 | 未发布 | 未测试 |
| win32-x64 | 可用 | `win_amd64` | 未测试；工作进程用例在 Windows 上跳过 |
| win32-arm64 | 可用 | 未发布 | 未测试 |

Alpine 等 musl 宿主安装 `@zvec/bindings-linux-x64-musl` 或 `@zvec/bindings-linux-arm64-musl`，没有对应通道。两个 Linux 通道已在 `.github/workflows/testing-platform-ci.yml` 中声明，还没有托管执行结果。在 darwin-arm64 上，通道在提供 turbovec 工作进程时执行了 47 个用例，在未配置工作进程时执行 42 个用例、仅跳过那 5 个 turbovec 用例；该平台属必经平台，其它任何用例跳过都会让通道失败，因此未配置工作进程的执行证明的是绑定与已发布入口，而非工作进程。配置启用检索之前检索始终关闭，因此在这些平台成功执行 `pnpm install` 只能证明依赖树已完成解析。

## Recover or disable

根据报告的操作和错误代码选择恢复方式。复制或恢复索引目录时应停止应用。

| 情况 | 操作 |
|---|---|
| 文件发生变化或消失 | 以 `source: "workspace"` 调用 `context_index`；哈希识别重复或变化的内容 |
| 来源索引过期，或派生账本损坏 | 以 `source: "rebuild"` 调用 `context_index`；清除并重建获授权的来源段落，保留显式记忆 |
| 记忆写入报告 `outcome_pending` | 检查 `memory_status`；以 `source: "rebuild"` 调用 `context_index`，完成获授权的暂存修改后再继续依赖操作 |
| 嵌入模型、权重、端点或维度改变 | 备份旧索引；选择新的 `indexDir` 与 `statePath` 后重新索引，再用 `/memory-import` 导入旧存储导出的记忆 |
| 权威 Zvec 集合损坏 | 停止应用并恢复可靠备份；来源重建不能修复丢失的显式记忆 |
| 集合目录存在但没有任何已提交版本 | 若该存储从未提供过读取，删除索引目录并重新索引；否则请恢复备份 |
| turbovec 不可用 | 使用 Zvec；检查 `memory_status`，修正工作进程路径或依赖后再重启 |
| 删除记忆 | 用 ID 或获授权的作用域调用 `memory_forget`；会验证权威存储中的删除结果 |
| 暂时隐藏工具 | 设置 `retrieval-tools.config.enableTools: false`，同时关闭自动检索 |
| 禁用子系统 | 不加载可选配置，或在配置中禁用全部五个检索条目 |

重建会重新读取配置的文件以及可通过 Session 持久化服务访问的获授权工作区会话；它无法恢复不可用的源日志，或已从权威存储删除的显式记忆。嵌入空间变化不会就地改写当前挂载的存储：必须先从旧存储导出，再导入新存储。请保护旧备份，因为在某次删除之前制作的备份仍包含该事实，而拒绝恢复的依据只存在于当前 `portabilityDir` 下的遗忘账本中——换一个 `portabilityDir` 或换一台机器都不会带走它。

## Privacy and verification limits

索引器默认排除常见秘密文件、凭据、生成目录、运行时状态及 `.git`，并拒绝路径穿越和符号链接逃逸。这些排除规则无法识别粘贴在普通源文件中的秘密：请谨慎选择索引根目录。检索文本是不可信证据，永远不会成为系统指令。

遗忘会移除可搜索记录，并阻止过期加速器 ID 再次返回它们。启用可迁移功能后，每次经确认的删除还会把记录 ID 与内容摘要追加到遗忘账本，后续导入因此拒绝它。遗忘不会抹除历史 Session 工具结果、文件系统历史、备份或可恢复存储块。显式索引的记录和文件仍可能独立于已删除记忆 ID 包含相同事实。请使用各原始系统的保留控制处理这些副本。记忆导出和账本都是 `portabilityDir` 下的明文；请把该目录视为私有存储，不要提交到 Git，并删除或妥善保护不再需要的导出文件。

[无密钥 headless 记录](../../../snapshots/session/local-retrieval/snapshot.yml)通过正式配置验证带源链接的索引与检索。[真实 Loader 工作流](../../../packages/retrieval/retrieval-tools/tests/composition.spec.ts)使用本地脚本模型验证合成的跨会话回忆、修正、重启后仍有效的删除、工作进程回退以及同存储工作区隔离。[可迁移协议测试](../../../packages/retrieval/retrieval/tests/portability-ops.spec.ts)与[命令测试](../../../packages/retrieval/retrieval-tools/tests/portability.spec.ts)在原生存储上验证导出导入的准入判定、故障注入回滚、中断日志恢复以及写入新空间的重新嵌入。这些测试确认工具编排，而非真实模型的任务准确率。[真实模型套件](../../../packages/retrieval/retrieval-tools/tests/model.e2e.ts)额外需要可调用工具的模型密钥，覆盖依赖证据的回答、跨会话回忆、记忆修正、重启后遗忘与工作区隔离；所有用例在没有 `DEEPSEEK_API_KEY` 时自动跳过。索引器要求会话文件系统映射到相同的原生宿主目录；会拒绝 SSH 和不相关的执行环境。[平台支持](#platform-support)一节说明了哪些平台由必需通道覆盖，并且该集成尚不能据此认定可用于多用户生产部署。

## Dev Note

[记忆可迁移格式 Agent Note](../../../.agents/notes/implemented/feature/2026-11-02-memory-portability-format.zh.md)记录了遗忘为何在删除之前写入账本条目、待处理记录为何不能导出，以及导入为何重新嵌入而不是复制向量。
