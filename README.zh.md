---
description: "构建 TestingPlatform，启动包含模型插件的 DeepSeek Harness，并发送第一条模型请求。"
---
# TestingPlatform

[English](README.md) | 中文

<a id="summary"></a>

## 概述

TestingPlatform 将完整的 **Our Free Model** 插件与 DeepSeek Harness 放在同一仓库中，让你通过 Harness Web 界面进行模型实验。安装一次，启动一个应用，在插件中配置提供商，然后在聊天输入框中选择模型。Harness 源码位于仓库根目录，插件位于 [`plugins/dsh-our-free-model/`](plugins/dsh-our-free-model/)。

<a id="contents"></a>

## 目录

- [前置条件](#prerequisites)
- [运行组合应用](#run)
- [发送第一条模型请求](#send-your-first-model-request)
- [连接自己的 API 密钥或本地模型](#connect-your-api-key-or-local-model)
- [启用其他功能](#enable-additional-functionality)
- [状态凭据与环境变量](#state-credentials-and-environment)
- [故障排查](#troubleshooting)
- [开发](#development)

<a id="prerequisites"></a>

## 前置条件

请在克隆前准备以下工具。完整源码构建包含 Harness 的浏览器与桌面包；使用组合 Web 界面不需要额外构建插件的桌面安装包。

| 要求 | 配置方式 |
|---|---|
| Node.js | **24.9 或更高版本**，包含 npm 和开发头文件。可使用当前 Node 24 版本，参见[官方下载说明](https://nodejs.org/en/download)。 |
| 包管理器 | **pnpm 11.28.5**，版本固定在 [`package.json`](package.json) 中。 |
| Git | **2.26 或更高版本**，并具有本仓库访问权限。克隆私有仓库时若要求认证，请使用自己的 GitHub 账号。 |
| macOS | 如果尚未安装，请安装 Apple 命令行开发工具（`xcode-select --install`）。原生扩展需要 C 编译器及 Node 安装目录中的 `include/node/node_api.h`。 |
| Linux | 安装 C 构建工具链（Debian/Ubuntu 上为 `build-essential`），并使用包含 `include/node/node_api.h` 的完整 Node 安装。 |
| Windows | 使用 Node、Git for Windows 和 PowerShell，或在独立的 WSL 2 检出目录中使用 Linux 工具。检出目录与 `node_modules` 应位于同一环境。可选的插件桌面打包还需要 Rust/MSVC。 |

如果尚未安装 `pnpm`，可通过 npm 安装固定版本：

```sh
npm install --global pnpm@11.28.5
node --version
pnpm --version
git --version
```

如果已经使用 Corepack，执行 `corepack enable` 后可由其选择仓库声明的版本。如果 Node 安装未包含 Corepack，或全局安装需要用户可写的前缀，请参阅 [pnpm 安装指南](https://pnpm.io/installation)。请保持 Node 的 TypeScript 类型剥离功能启用；构建前移除 `NODE_OPTIONS` 中的 `--no-experimental-strip-types`。

<a id="run"></a>

## 运行

以下命令安装并启动组合后的 TestingPlatform 配置。在运行应用的机器上打开终端执行。

<a id="run-from-source"></a>

### 从源码运行

```sh
git clone https://github.com/LUNCY579/TestingPlatform.git
cd TestingPlatform
pnpm install --frozen-lockfile
pnpm run setup
pnpm start
```

`setup` 会构建应用、检查 TypeScript 程序并准备本地插件配置。请等待该命令成功完成后再启动。首次安装和构建可能需要数分钟。安装过程不会登录提供商、下载模型权重或发送模型生成请求。

`pnpm start` 会打开 Web 界面，默认地址通常是 `http://127.0.0.1:3080`。如果浏览器没有自动打开，请使用**终端输出的完整 URL**，其中包含用于建立浏览器会话的启动令牌。请勿分享该 URL。浏览器与服务器使用 Harness 原有的会话认证流程。

如需指定其他端口并自行打开输出的链接：

```sh
pnpm start --no-open --port 3081
```

使用界面时请保持终端运行。按 **Ctrl+C** 停止应用；再次执行 `pnpm start` 即可继续使用已保存的配置和会话。无需从 npm 再安装一份插件，此配置已经直接链接仓库中的插件源码。

<a id="send-your-first-model-request"></a>

## 发送第一条模型请求

建议先完成两个检查：在插件中获取一次简短文本回复，再通过 Harness 进行正常对话。使用可用的免密钥插件模型或本地推理服务时，不需要 DeepSeek API 密钥。其他提供商可能需要账号、订阅或付费 API 密钥；插件名称不代表所有访问都免费。

<a id="1-check-a-response-inside-the-plugin"></a>

### 1. 在插件中检查模型回复

1. 首次启动时，在 Harness 预览提示中选择 **Continue**（继续）。打开 **Settings → Our Free Model**（设置 → Our Free Model），确认插件的首次使用提示（中文确认按钮为**我已阅读并了解**），然后选择 **Free models**（免费模型）。**Try your first model call**（尝试首次模型调用）面板也会说明此流程。
2. 如有需要，刷新模型列表。选择当前可用的模型卡片，点击 **Text test**（文本测试）。列表中的模型仍可能受网络或账号条件限制。
3. 等待 **Model reply**（模型实际回复）面板出现。测试向选中模型发送 `Reply with exactly: OK`，展示实际返回文本及时间和 Token 指标。这是一次真实生成请求，不使用 agent（智能体）工具。较慢的提供商最多可能需要五分钟。
4. 如果测试失败，请阅读显示的提供商错误，检查登录、额度和网络要求，然后尝试其他模型或[连接自己可控的提供商](#connect-your-api-key-or-local-model)。成功获取模型列表并不能证明生成请求可用。

<a id="2-chat-through-the-harness-interface"></a>

### 2. 通过 Harness 界面聊天

1. 返回主会话界面，在工作区选择器中选择准备使用的项目目录（未选中时显示 **Choose workspace**，即选择工作区）。如有需要，先添加目录；请确认选择，不要依赖自动选中的默认目录。**聊天输入框要求先选中工作区。**
2. 新建会话。打开输入框的模型选择器，展开 **Our Free Model** 并选中刚刚测试的模型。通过聚合渠道添加的模型使用 `provider/model` 标识。
3. 发送以下简短提示作为首次对话：

> Reply with exactly: TestingPlatform is connected.

4. 确认助手返回文本。打开 **Settings → Our Free Model → Request log**（运行日志），查看对应的模型调用及提供商错误。
5. 成功后，可以尝试“列出此工作区的顶层文件，不修改它们”等工作区任务。工具调用还取决于所选模型的能力及当前权限策略；请根据操作内容处理审批提示。

<a id="connect-your-api-key-or-local-model"></a>

## 连接自己的 API 密钥或本地模型

使用 **Our Free Model → Aggregate**（聚合渠道）可以通过集成插件调用自己的提供商。独立的 Harness **Settings → Models** 页面用于配置 Harness 原生提供商；如果希望使用并验证此插件的路由与日志，请使用 Aggregate。

<a id="an-api-provider"></a>

### API 提供商

1. 选择 **Add provider**（添加提供商），找到提供商后点击 **Configure**（配置）。标记为 **Not drivable**（不可驱动）的条目需要此通用 API 密钥路径无法执行的认证流程。
2. 输入 API 密钥，并按需填写接口的 **Base URL**。保持提供商启用。
3. 先点击 **Add**（添加）或 **Save**（保存）。**Test**（测试）和 **Discover models**（发现模型）使用服务器中已保存的配置，不会使用表单内尚未保存的内容。
4. 点击 **Test** 检查模型列表接口，再点击 **Discover models** 获取可用模型 ID。如果不支持发现模型或结果为空，请在 **Model override**（模型覆盖）中输入提供商的准确模型 ID，以逗号或换行分隔，然后保存。显式覆盖优先于自动发现。
5. 返回 Harness，新建会话，在 **Our Free Model** 下选择该提供商的模型。发送上面的简短提示验证生成；提供商的 **Test** 按钮检查模型列表，不执行生成。

<a id="a-local-inference-server"></a>

### 本地推理服务

请先安装所选推理应用，在其中加载或下载模型，并启动其兼容 OpenAI 的服务，再配置聚合渠道。TestingPlatform 提供界面与适配器，不安装模型权重或推理运行时。

| 聚合渠道提供商 | 默认基础 URL | API 密钥 |
|---|---|---|
| Ollama | `http://localhost:11434/v1` | 仓库中的本地配置不要求密钥。 |
| LM Studio | `http://localhost:1234/v1` | 仓库中的本地配置不要求密钥。 |
| llama.cpp | `http://localhost:8080/v1` | 仓库中的本地配置不要求密钥。 |

按照同样的 **Configure → Add/Save → Discover models** 流程操作。这些条目不预置模型 ID：请发现运行中服务器的模型，或在 **Model override** 中保存准确 ID。如果服务器使用其他端口或认证，请与之保持一致。`localhost` 指运行 Harness 服务的机器或环境；使用远程浏览器或 WSL 时，它可能不同于浏览器所在机器或 Windows 主机。

<a id="enable-additional-functionality"></a>

## 启用其他功能

组合配置包含 Harness 基础工具与插件管理界面。按需启用外部账号和可选服务，各项功能仍有自己的前置条件。详细的提供商行为参见插件的[完整英文指南](plugins/dsh-our-free-model/README_EN.md)。

| 功能 | 配置位置 | 所需条件 |
|---|---|---|
| 账号渠道 | **Our Free Model → EAC router** | 使用该渠道自己的流程登录，启用支持的账号或渠道，并选择可用模型。 |
| 订阅或 API 账号 | **Our Free Model → Model workspace**（模型工作台） | 添加相应账号或有权使用的凭据；可用性与额度取决于该账号。 |
| 回退或轮询模型 | **Our Free Model → Routing**（路由） | 先配置可用的成员模型，保存路由，然后在输入框中选择对应的虚拟模型。 |
| 用量、延迟与失败 | **Dashboard**（数据看板）与 **Request log**（运行日志） | 先进行模型请求；图表和日志来自实际记录的调用。 |
| 供其他客户端调用的兼容 OpenAI API | **Free models → Local forward**（本地转发），然后 **Gateway → Connect a client**（接入客户端） | 启用转发端口，再将界面显示的基础 URL、密钥和模型 ID 填入客户端。具体步骤见下文。 |
| 工具输出压缩与提示调整 | **Our Free Model → Token savers**（省 Token） | 显式启用所需选项，并比较实验效果；提示调整会改变模型输入。 |
| 文件、命令、计划与 subagent | Harness 会话与工作区 | 选中的工作区、合适的模型、必要的主机工具及当前权限策略。参见 [Web 指南](docs/user/guide/index.zh.md)。 |
| MCP 工具与记忆服务器 | 配置补丁 | 安装或启动外部 MCP 服务器，并配置其命令或 URL。参见 [MCP 指南](docs/user/guide/mcp-memory.zh.md)。 |
| 定时任务 | Harness 设置与会话工具 | 配置可用模型及所需计划；参见[定时任务指南](docs/user/guide/schedule.zh.md)。 |
| 网页搜索与获取 | Harness 网页提供商 | 按[网页包指南](packages/web/README.zh.md)配置所选提供商的凭据与限制；匿名 HTTP 获取与提供商支持的搜索具有不同要求。 |
| 浏览器或桌面自动化 | 可选 Harness 提供商 bundle | 选择一个后端，并按[浏览器](packages/browser-use/README.zh.md)或[计算机操作](packages/computer-use/README.zh.md)提供商指南安装浏览器及配置操作系统权限。部分提供商处于实验阶段。 |
| SSH 远程执行 | 无界面或自定义配置 | 按 [SSH 指南](packages/ssh/README.zh.md)准备可访问的 POSIX 主机、OpenSSH 连接及远程辅助程序。 |
| 运营者托管的 EAC 网关 | 插件 [`worker/README.md`](plugins/dsh-our-free-model/worker/README.md) | 单独部署服务，并配置自己的上游接口、授权密钥与签名密钥；连接客户端前应先完成托管配置。 |
| Python 自动化 | [`python/`](python/) | 按 [SDK 指南](docs/user/guide/python-sdk.zh.md) 安装 SDK/运行时，并选择可执行文件、配置与 Harness 主目录。Python 捆绑运行时不会自动继承此检出目录的插件。 |
| 独立插件服务或桌面包 | 插件 [`PACKAGING.md`](plugins/dsh-our-free-model/PACKAGING.md) | 单独的嵌套依赖与平台工具链；这些是可选应用，当前 Web 流程不需要它们。打包路径应以插件目录为基准。 |

<a id="connect-another-client-through-the-plugin"></a>

### 通过插件连接其他客户端

1. 首先验证模型可以在 Harness 内回复。
2. 在 **Free models → Local forward** 中启用转发端口。默认关闭，初始请求回环端口 `18899`；该端口被占用时，监听器可能选择其他端口。
3. 打开 **Gateway → Connect a client**。复制该页面显示的**实际绑定 URL 与生成的密钥**，以及列表中的模型 ID。网关 URL 和密钥不同于 Harness Web 登录 URL。
4. 将客户端配置为界面显示的兼容 API，发送一个简短请求，并在 **Request log** 中检查结果。客户端使用转发服务期间应保持 Harness 运行。

<a id="gemini-account-configuration"></a>

### Gemini 账号配置

Gemini 账号登录或刷新，以及导入的 Gemini CLI 订阅刷新，分别需要匹配的 OAuth 客户端凭据。这是两项独立集成：

| 操作 | 必需的密钥变量 | 可选的匹配客户端 ID |
|---|---|---|
| Gemini 渠道登录或刷新 | `CMDC_PAK_GOOGLE_CLIENT_SECRET` | `CMDC_PAK_GOOGLE_CLIENT_ID` |
| Gemini CLI 订阅刷新 | `OFM_GEMINI_CLIENT_SECRET` | `OFM_GEMINI_CLIENT_ID` |

请在启动前设置相关变量，并使用自己有权使用的 OAuth 客户端。其他提供商不要求这些变量。当对应登录或刷新需要密钥但未配置时，会返回配置错误；尚未过期的导入令牌在刷新前仍可能可用。参见[插件集成指南](plugins/dsh-our-free-model/TESTINGPLATFORM.md#gemini-oauth-configuration)。

可选的捆绑 **Magpie 引擎仅支持 Windows x64**。组合启动或安装过程会校验并还原仓库中的分片资源；在其他操作系统上还原文件并不代表可以在该系统运行引擎。这不影响使用插件支持的其他提供商。

<a id="state-credentials-and-environment"></a>

## 状态、凭据与环境变量

除非导出其他 `DSH_HOME`，组合启动器会将配置、会话、凭据及插件设置保存在此检出目录中被 Git 忽略的 **`.testingplatform/`** 目录下。保留实验时请备份该目录；删除它可能丢失会话及登录信息。用户主目录中原有的 Harness 安装保持独立。

活动配置位于 `.testingplatform/profiles/testing-platform/`。重复运行安装会保留已有个人设置。插件采用 **managed** 模式，自更新器不会替换仓库源码。请通过 Git 更新源码，并在依赖或需要构建的代码改变时重新执行冻结安装与 setup。

提供商参数可来自启动环境或私有 `.env` 文件。CLI 在启动时读取仓库根目录的 `.env` 和 `$DSH_HOME/.env`，优先级为**已导出的环境变量 → 仓库 `.env` → Harness 主目录 `.env`**。之后选择工作区不会改变该搜索范围。修改环境文件后请重启。

请在 shell 中导出 `DSH_HOME`、`PATH` 和 `DSH_*` 等启动设置；`.env` 文件会拒绝这些变量。代理变量应放在启动环境或 Harness 主目录的 `.env` 中，不应放在仓库根目录的 `.env` 中。准确规则参见[环境变量参考](packages/boot/app-boot/README.zh.md)与[代理指南](docs/user/guide/network-proxy.zh.md)。请勿提交 API 密钥、账号令牌或运行时状态。

<a id="troubleshooting"></a>

## 故障排查

请根据症状选择下一项检查。下面的验证命令使用本地 fixture（测试前置数据）；检查通过并不代表外部提供商当前接受你的账号请求。

| 症状 | 检查或恢复方式 |
|---|---|
| 找不到 `pnpm` 或版本不正确 | 安装上述固定版本，在仓库根目录验证 `pnpm --version`。如果 PowerShell 的脚本策略阻止 `pnpm.ps1`，可使用 `pnpm.cmd`。 |
| 缺少 `apps/cli/lib/bin.js` 或 Web 资源 | 运行 `pnpm install --frozen-lockfile`，然后执行 `pnpm run setup`。`start` 使用已有构建，不会自动重建。 |
| 提示 `Node-API headers missing` 或找不到 `cc` | 在同一环境中安装 C 工具链与完整 Node 发行版，然后重新运行 setup。Linux/macOS 上只有单独的 `node` 可执行文件而无头文件时不够。 |
| 浏览器已打开，但请求返回 401 | 重新打开当前服务器输出的完整启动 URL，以建立浏览器会话。 |
| 3080 端口已被占用 | 执行 `pnpm start --no-open --port 3081` 并打开输出的 URL。 |
| 无法输入消息 | 选择工作区、新建会话并选中可用模型。服务器当前目录本身不会自动成为选中的工作区。 |
| 缺少插件设置或模型分组 | 使用 `pnpm start` 启动，然后运行 `pnpm run config:platform` 与 `pnpm run smoke:platform`。这些命令检查组合配置、本地主机插件及浏览器模块。 |
| 修改密钥后聚合测试或发现模型失败 | 先点击 **Add/Save**，再点击 **Test/Discover models**。检查保存的基础 URL 及提供商认证要求。 |
| 本地提供商显示零个模型 | 启动已加载模型的推理服务，发现其模型列表，或保存准确的模型 ID 覆盖。 |
| 模型已列出，但生成失败 | 查看提供商错误与运行日志。检查账号登录、额度、地区或网络访问、准确模型 ID，以及是否支持请求所需功能。可先尝试简短的纯文本提示。 |
| 配置已存在或链接指向其他位置 | 使用独立的 `DSH_HOME`，或备份并检查启动器报告的冲突配置或链接。不要盲目删除已有状态来修复。 |
| 远程浏览器无法连接或返回 403 | 按[公开部署指南](docs/user/guide/public-deployments.zh.md)配置可信主机、URL、转发与 TLS。默认回环地址用于本机使用。 |

<a id="development"></a>

## 开发

安装完成后，在仓库根目录执行以下命令。配置覆盖、文件监听行为、独立实验及源码归属参见[开发与状态参考](testing-platform/README.zh.md)。

| 命令 | 用途 |
|---|---|
| `pnpm run setup` | 构建并检查应用，准备组合配置。 |
| `pnpm start` | 启动已构建的组合 Web 应用。 |
| `pnpm run dev` | 构建资源、监听 Harness 浏览器包，并在已导入源码改变时重启源码 CLI。 |
| `pnpm run config:platform` | 输出组合后的有效配置，不启动服务器。 |
| `pnpm run test:integration` | 检查配置隔离、链接、重复安装、冲突及原生资源还原。 |
| `pnpm run smoke:platform` | 使用本地 fixture 检查组合服务器与插件集成。 |
| `pnpm run test:plugin` | 使用本地替身运行插件贡献者测试。 |

仓库保留原有 Harness 包、CLI 模式、Python SDK、文档与测试。参见 [Harness 开发指南](docs/development.zh.md)、[架构](docs/architecture.zh.md)和[插件集成说明](plugins/dsh-our-free-model/TESTINGPLATFORM.md)。可选上游应用和配置拥有各自的组合方式；`pnpm start` 才是选择本仓库集成 Web 配置的入口。

<a id="developer-preview"></a>

## 开发者预览

DeepSeek Harness 处于开发者预览阶段，API 与会话格式仍在演进。让 agent 操作重要项目之前，请阅读[安全说明](SAFETY.zh.md)。本次集成已运行的检查及其限制参见[验证记录](testing-platform/VALIDATION.md)；外部账号访问与原生平台行为需要在你自己的环境中验证。

<a id="contributing"></a>

## 贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。使用 agent 协助修改时，请遵守 [AGENTS.md](AGENTS.md)。[源码导入记录](testing-platform/source-import.json)标明两个导入快照，仓库保留了原始许可证与署名。

<a id="citation"></a>

## 引用

DeepSeek Harness 由 [DeepSeek AI](https://deepseek.com) 基于 [Cordis](https://github.com/cordiverse/cordis) 开发。发表使用该项目的工作时，请保留引用：

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

<a id="license"></a>

## 许可证

Harness：[MIT](LICENSE)。插件：[MIT](plugins/dsh-our-free-model/LICENSE)。捆绑依赖的许可证参见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与插件中的第三方声明。

<a id="dev-note"></a>

## 开发备注

无。
