# TestingPlatform

[English](README.md) | 中文

TestingPlatform 在仓库根目录保留完整的 DeepSeek Harness 应用，并在 [`plugins/dsh-our-free-model`](../plugins/dsh-our-free-model/) 下保留完整的 Our Free Model 插件。一个 pnpm 工作区安装两者，合并启动器把本地插件加载到 Harness Web 配置中。

## 配置与启动

使用 Node.js 24.9 或更新版本，以及根目录 `package.json` 固定的 pnpm 11.28.5。Linux 和 macOS 上的 Harness 原生扩展需要包含开发头文件的完整 Node 安装以及 C 编译器。若尚未安装，请在 macOS 上安装 Apple 命令行工具，或在 Linux 上安装 C 构建工具链。首次构建会处理完整的上游应用，包括桌面端与浏览器软件包。

```sh
git clone https://github.com/LUNCY579/TestingPlatform.git
cd TestingPlatform
pnpm install --frozen-lockfile
pnpm run setup
pnpm start
```

`setup` 构建并检查 Harness，然后准备 `testing-platform` 配置。`start` 运行已构建的 CLI 并打开 Web 界面，通常地址为 `http://127.0.0.1:3080`。插件在该应用中提供模型管理界面。使用其他端口或禁止自动打开浏览器：

```sh
pnpm start --no-open --port 3081
```

配置过程不会登录供应商，也不会发送模型请求。供应商可用性、账号要求和可能产生的使用费用取决于所选渠道；插件原名不保证所有供应商始终免费。运行细节见[插件文档](../plugins/dsh-our-free-model/)和 Harness 的[安全说明](../SAFETY.zh.md)。

## 开发与检查

| 命令 | 用途 |
|---|---|
| `pnpm run setup` | 构建并检查完整 Harness 的类型，然后准备合并配置。 |
| `pnpm start` | 启动已构建的合并应用。 |
| `pnpm run dev` | 构建产物、监视 Harness 浏览器 bundle，并在已导入的宿主或插件文件变化时重启源码 CLI。 |
| `pnpm run config:platform` | 打印实际生效的合并 Cordis 配置，不启动服务器。 |
| `pnpm run test:integration` | 检查本地配置隔离、链接、重复配置和冲突处理。 |
| `pnpm run test:plugin` | 运行插件的贡献者测试套件。 |
| `pnpm run smoke:platform` | 启动临时合并 Web 配置，检查宿主 API 和浏览器插件，不请求模型生成。 |

原有 Harness 脚本、软件包、测试、原生源码、Python SDK 和文档仍然可用。`pnpm dsh web` 运行原有 Harness 配置；合并后的 TestingPlatform 使用 `pnpm start`。插件 JavaScript 从本地目录加载。其独立版、桌面版、worker、文档和测试保留在同一目录中；嵌套应用的工具链保留各自的上游清单。

插件的浏览器入口已经是 JavaScript。编辑后刷新浏览器即可；重启 `pnpm run dev` 也会重新加载宿主的客户端模块元数据。开发命令使用现有 Harness 浏览器监视器处理其 TypeScript/TSX 客户端软件包。重新安装依赖或执行完整配置前，请先按 Ctrl+C 停止开发进程。

## 本地状态与配置

除非显式设置 `DSH_HOME`，启动器使用当前仓库中的 `.testingplatform/` 作为 Harness 主目录。Git 忽略此目录，其中包括配置、凭据、会话、插件设置和其他运行数据。因此，用户主目录中正常安装的 Harness 与该仓库互相独立。若要隔离多个实验，请按照所用 shell 的环境变量语法为各进程设置不同的 `DSH_HOME`。

生成的配置位于 `$DSH_HOME/profiles/testing-platform/`。其 `package.json` 选择 Harness 基础 bundle、Web 应用 bundle 和一次本地插件。`node_modules/dsh-our-free-model` 直接链接到本仓库；Windows 使用目录联接。重复配置会保留现有清单和个人 `cordis.patch.yml` 覆盖配置；发现冲突配置或插件安装时会报错，不会替换它们。

[`managed.patch.yml`](managed.patch.yml) 设置 `distribution: managed`，表示插件文件由 Git 管理，因此插件自己的更新器、上游公告轮询和自重载保持关闭。更新插件时，在本仓库中审查并提交源码变更。插件仍名为 `dsh-our-free-model`，bundle 使用裸软件包名称，让 Harness 同时发现并提供浏览器入口。

合并启动器默认禁用上游遥测。显式设置的 `DSH_TELEMETRY_DISABLED` 优先。除此之外，启动器保留 Harness 正常的身份验证和运行行为。

## 故障排查

- **缺少依赖：**先执行冻结锁文件安装，再配置。插件是本地工作区依赖，无需从 npm 安装另一份。
- **缺少构建产物：**运行 `pnpm run setup`。`start` 不会隐式重新构建。
- **缺少 Node-API 头文件：**使用包含 `include/node/node_api.h` 的完整 Node 发行版，然后重新配置。
- **配置已存在或本地链接指向其他位置：**选择另一个 `DSH_HOME`，或先备份提示中的冲突配置或链接，再重新创建。启动器会保留已有数据。
- **端口已占用：**使用 `pnpm start --port 3081` 选择其他端口。
- **宿主中有插件但界面缺失：**运行 `pnpm run smoke:platform`，分别检查浏览器模块图、提供的客户端 bundle 和经过身份验证的宿主 API。

## 源码与许可证

本目录中的源码导入记录和导入说明标识确切的源码快照。Harness 的 [MIT 许可证](../LICENSE)、插件的 [MIT 许可证](../plugins/dsh-our-free-model/LICENSE) 及其第三方声明与导入文件保留在一起。上游文档和软件包元数据中的原仓库 URL 保留其来源说明与支持含义。
