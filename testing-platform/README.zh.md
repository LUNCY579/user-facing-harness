---
description: "开发组合后的 TestingPlatform 检出目录，管理独立配置并检查本地集成验证。"
---
# TestingPlatform 开发参考

[English](README.md) | 中文

<a id="summary"></a>

## 概述

完成[根 README 的安装与首次调用教程](../README.zh.md)后，可使用此参考了解修改位置、组合配置的设置保存方式，以及 Harness 到插件的集成验证。

<a id="contents"></a>

## 目录

- [仓库布局](#repository-layout)
- [开发循环](#development-loop)
- [配置与独立实验](#profiles-and-isolated-experiments)
- [集成检查](#integration-checks)
- [可选应用](#optional-applications)
- [源码与许可证](#source-and-licenses)

<a id="repository-layout"></a>

## 仓库布局

根 pnpm 工作区共同安装 Harness 与插件。各个应用保留自己的源码及可选工具链文件。

| 位置 | 职责 |
|---|---|
| [`apps/`](../apps/) 和 [`packages/`](../packages/) | Harness CLI、Web 或桌面应用、工具、服务及客户端。 |
| [`plugins/dsh-our-free-model/`](../plugins/dsh-our-free-model/) | 完整插件、提供商适配器、浏览器界面、独立或桌面应用源码、worker 与测试。 |
| [`launcher.mjs`](launcher.mjs) | 组合安装、启动、开发与配置命令。 |
| [`profile.mjs`](profile.mjs) 和 [`profile.json`](profile.json) | 检出目录内的 Harness 主目录及单个本地插件 bundle。 |
| [`managed.patch.yml`](managed.patch.yml) | 仓库管理的插件更新行为。 |
| [`assets/README.md`](assets/README.zh.md) | 可选 Windows 引擎的校验分片与还原说明。 |
| [`python/`](../python/) | Python SDK 与运行时载体。 |

<a id="development-loop"></a>

## 开发循环

完成首次冻结安装与 setup 后，启动组合开发命令：

```sh
pnpm run dev
```

此命令构建资源、监听 Harness 浏览器包，并使用 TestingPlatform 配置启动源码 CLI。Node 文件监听器在已导入的主机或插件源码改变后重启该 CLI。Harness 原有监听器负责重建其 TypeScript/TSX 客户端包。重新安装依赖或运行完整 setup 前，请先用 Ctrl+C 停止进程。

插件的 `client.js` 已经是浏览器 JavaScript。编辑后刷新页面；如果运行中的主机仍发布缓存的客户端模块元数据，请重启开发命令并再次刷新。请修改本地插件，不要额外安装 npm 副本。修改生成渠道的源文件后，请按[插件集成指南](../plugins/dsh-our-free-model/TESTINGPLATFORM.md#regenerating-channel-bundles)重新生成。

`pnpm start` 使用已构建的 Harness 资源，不会重新构建。如果依赖或构建输入改变，而你希望继续使用该命令，请重新执行 `pnpm run setup`。原有 `pnpm dsh web` 启动上游 Web 配置，不会自动选择组合配置。

<a id="profiles-and-isolated-experiments"></a>

## 配置与独立实验

生成的配置位于 `$DSH_HOME/profiles/testing-platform/`。其 `package.json` 各选择一次 Harness 基础 bundle、Web 应用 bundle 与 `dsh-our-free-model`。`node_modules/dsh-our-free-model` 直接链接到此检出目录；Windows 使用目录联接。重复 setup 会保留已有配置清单及个人 `cordis.patch.yml` 覆盖设置。发生配置或插件安装冲突时，会报告路径并失败，不会替换已有内容。

个人覆盖设置应放在该配置的 `cordis.patch.yml` 中；添加补丁时保留已有条目。额外的 `--patch` 参数可以加载实验专用文件；请将其放在 `--no-open` 或 `--port` 等应用参数之前，因为 CLI 遇到应用参数后会停止解析自己的选项。插件只需注册一次，所选 bundle 已经提供它的 Cordis 条目。补丁组合方式参见 [CLI 配置参考](../apps/cli/README.zh.md)。

如需隔离另一个实验，请在启动前导出 `DSH_HOME`。以下路径仍位于被 Git 忽略的运行目录中，但使用独立的配置、会话和凭据。

macOS/Linux：

```sh
export DSH_HOME="$PWD/.testingplatform/experiment-a"
pnpm start --no-open --port 3081
```

PowerShell：

```powershell
$env:DSH_HOME = Join-Path (Get-Location) '.testingplatform/experiment-a'
pnpm start --no-open --port 3081
```

返回默认实验时，请使用新终端或移除该环境变量覆盖。并发实验共用同一主目录也会共用凭据与配置。环境文件加载规则及启动变量限制参见[根 README](../README.zh.md#state-credentials-and-environment)。

托管模式禁用插件的上游自更新、公告轮询与自重载，使实验源码由 Git 管理。组合安装、启动及开发命令还会从已校验的本地分片还原可选原生资源。启动器默认禁用上游遥测，显式导出的 `DSH_TELEMETRY_DISABLED` 优先。Harness 原有认证与权限行为保持启用。

<a id="integration-checks"></a>

## 集成检查

构建当前检出目录后，运行针对性检查：

```sh
pnpm run test:integration
pnpm run smoke:platform
pnpm run test:plugin
```

配置检查覆盖隔离与本地链接。冒烟测试启动临时组合 Web 配置，验证其经过认证的主机及浏览器插件，注册本地兼容 OpenAI 的测试提供商，发现模型并检查经插件返回的流式回复。它不会验证真实外部模型或账号。贡献者测试使用本地替身；插件内的 `npm run selftest` 是单独的真实提供商操作。

如果只需要查看配置，运行 `pnpm run config:platform`。已记录的结果及平台或提供商限制参见 [VALIDATION.md](VALIDATION.md)。更广泛的测试参见 [Harness 测试指南](../docs/testing.zh.md)，构建与类型检查行为参见[开发指南](../docs/development.zh.md)。

<a id="optional-applications"></a>

## 可选应用

组合 Web 配置是一起测试 Harness 与插件的主要入口。保留的插件独立或桌面应用拥有独立入口及数据目录，不显示 Harness 工作区和会话界面。

插件包含已构建的独立 Web 资源。完成根工作区安装后，独立服务可直接使用这些资源：

```sh
node plugins/dsh-our-free-model/packages/standalone/cli.mjs --data-dir .testingplatform/standalone
```

打开该进程输出的完整管理 URL。默认请求端口为 `18900`，实际绑定端口可能不同。按 Ctrl+C 停止服务。上述显式数据目录可避免与常规独立安装混用。服务、Windows 桌面工具链、安装包及验证要求参见[打包指南](../plugins/dsh-our-free-model/PACKAGING.md)。

在组合检出目录中使用打包说明时，根目录的 `pnpm install --frozen-lockfile` 替代上游插件根目录的 `npm ci` 步骤，因为此插件使用本地 `workspace:*` 依赖。嵌套独立与桌面应用的构建依赖保留各自锁文件，仍需要文档中的独立安装步骤。涉及插件相对路径的打包操作应从 `plugins/dsh-our-free-model/` 执行。构建或验证原生 Windows 安装包需要 Windows 构建机器，运行 Web 应用不需要。

[Python SDK 指南](../docs/user/guide/python-sdk.zh.md)说明其运行时及显式 Harness 主目录选择。捆绑运行时使用自己的配置；请选择并配置所需运行时与插件组合，不要假定它会继承正在运行的 TestingPlatform Web 进程。

<a id="source-and-licenses"></a>

## 源码与许可证

[源码导入记录](source-import.json)与[导入说明](import-notes.md)标明固定快照及集成决策。Harness 的 [MIT 许可证](../LICENSE)、插件的 [MIT 许可证](../plugins/dsh-our-free-model/LICENSE)及第三方声明与导入文件保留在一起。[原生资源参考](assets/README.zh.md)记录原始可执行文件与保持校验一致的归档表示。

<a id="dev-note"></a>

## 开发备注

无。
