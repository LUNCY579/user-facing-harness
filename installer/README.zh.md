# TestingPlatform 安装程序——通俗指南

[English](README.md) | 中文

## 下载（推荐方式）

你正在查看仓库 `installer/` 文件夹中的此文件：https://github.com/LUNCY579/TestingPlatform/tree/main/installer

只下载适用于你电脑的文件。不要为了获取安装程序而克隆仓库——安装程序会自行克隆仓库。

- **Mac：** 在终端中进入要保存安装程序的文件夹，然后运行：
  ```sh
  curl -O https://raw.githubusercontent.com/LUNCY579/TestingPlatform/main/installer/install-mac.sh
  chmod +x install-mac.sh
  ./install-mac.sh
  ```
  也可以打开文件页面，使用 **Download raw file**：https://github.com/LUNCY579/TestingPlatform/blob/main/installer/install-mac.sh
- **Windows：** 在 PowerShell 中进入要保存安装程序的文件夹，然后运行：
  ```powershell
  Invoke-WebRequest -Uri https://raw.githubusercontent.com/LUNCY579/TestingPlatform/main/installer/install-windows.ps1 -OutFile install-windows.ps1
  Unblock-File .\install-windows.ps1
  powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
  ```
  不要手动从浏览器页面复制脚本文本后粘贴到文件中——浏览器保存可能会添加 `.txt` 或更改换行符。请使用上面的下载命令，或文件页面的 **Download raw file** 按钮：https://github.com/LUNCY579/TestingPlatform/blob/main/installer/install-windows.ps1


此安装程序只负责安装准备。它会在你的电脑上安装、构建并启动 TestingPlatform，不执行其他操作。这是有意限定的：安装准备曾是困难环节，因此此程序只解决安装准备问题。

## 开始前

- 你需要联网，并留出几分钟。首次安装和构建可能需要数分钟。整个过程都要保持终端或 PowerShell 窗口打开。
- 仓库是公开的，因此你**不需要** GitHub 账户，也**不需要**任何人为你授予访问权限。安装程序会匿名克隆仓库，绝不会索要密码、token 或密钥。如果出现登录提示，请停止：这表示仓库尚未公开，应等待后再试。
- 安装时**不需要**选择模型。参与者使用的模型会记录在会话日志中（导出包含确切的模型 ID），因此安装时没有单独的模型选择步骤。

## Mac

1. 按照上文“下载”中的说明下载 `install-mac.sh`。
2. 打开终端，进入保存脚本的文件夹，然后运行：
   ```sh
   chmod +x install-mac.sh
   ./install-mac.sh
   ```
   如果希望双击启动：将其复制为名为 `install-mac.command` 的文件，再双击该副本。如果 macOS 阻止运行，请右键点击并选择“打开”。
3. 安装程序会先检查环境，再安装和构建，最后启动 harness 并打印一个 URL（通常为 `http://127.0.0.1:3080`）。该 URL 含有登录 token：请保密，不要分享。
4. 使用 harness 时保持终端窗口打开。按 Ctrl+C 停止。

以后再次启动时，双击 TestingPlatform 文件夹中的 `start-demo.command`，或在终端中运行：
```sh
cd ~/Downloads/TestingPlatform
pnpm start
```

## Windows

1. 按照上文“下载”中的说明下载 `install-windows.ps1`。
2. 注意：双击 `.ps1` 文件通常会在编辑器中打开，而不是执行；下载的脚本也可能被 Windows 阻止（执行策略或“从互联网下载”的限制）。因此，请在 PowerShell 中进入保存脚本的文件夹，再按以下方式运行：
     ```powershell
     Unblock-File .\install-windows.ps1
     powershell -ExecutionPolicy Bypass -File .\install-windows.ps1
     ```
   右键 → **使用 PowerShell 运行**仅作为备用方式：下载的文件仍可能被执行策略阻止，此时请使用上面的两条命令。
3. 安装程序会先检查环境，再安装和构建，最后启动 harness 并打印一个 URL（通常为 `http://127.0.0.1:3080`）。该 URL 含有登录 token：请保密，不要分享。
4. 使用 harness 时保持 PowerShell 窗口打开。按 Ctrl+C 停止。

以后再次启动时，双击 TestingPlatform 文件夹中的 `start-demo.bat`，或在 PowerShell 中运行：
```powershell
cd $env:USERPROFILE\Downloads\TestingPlatform
pnpm start
```

## 安装位置

两个安装程序默认使用以下位置：

- Mac：`~/Downloads/TestingPlatform`
- Windows：用户文件夹中的 `Downloads\TestingPlatform`

如果该文件夹已有 TestingPlatform 检出，安装程序会更新它（仅允许快进），而不是再次克隆。如果该文件夹已存在但不是 TestingPlatform，安装程序会停止，不会删除任何内容——请选择其他文件夹，或先将旧文件夹移到别处再运行。

如需使用其他文件夹，请将路径传给安装程序：

```sh
./install-mac.sh ~/MyFolder/TestingPlatform
```

```powershell
powershell -ExecutionPolicy Bypass -File .\install-windows.ps1 -InstallDir "C:\Users\you\MyFolder\TestingPlatform"
```

## 安装程序检查什么

| 检查项 | 要求 | 失败时的处理方法 |
|---|---|---|
| macOS（Mac 脚本）/ Windows（PowerShell 脚本） | 使用适合电脑的脚本 | 改用另一个脚本 |
| Git | 2.26 或更高版本 | 安装或更新 Git 后重新运行 |
| Node | 24.9 或更高版本 | 见下文“Node 问题” |
| pnpm | 11.28.5（仓库固定版本） | 安装程序会用 npm 安装；如果失败，请运行 `npm install --global pnpm@11.28.5` 后重试 |
| Mac 命令行开发工具 | 已安装（原生扩展需要 C 编译器） | 运行 `xcode-select --install`，按提示操作后重新运行 |
| 仓库检出 | 存在 `package.json` 和 `testing-platform/launcher.mjs` | 重新运行；如果文件夹不正确，请使用新文件夹 |
| 原生绑定 | 安装后存在 rolldown 绑定文件夹 | 安装程序会强制彻底重装一次；如果仍缺失，见下文 |
| 安装准备 | `pnpm run setup` 通过（构建与检查） | 安装准备通过前不要启动；请报告错误 |

## Node 问题（最常见的安装准备失败）

安装程序**不会**在无提示的情况下替你更换 Node。如果因 Node 问题停止，请仔细阅读提示：

- **未安装 Node：** 从 https://nodejs.org/en/download 安装 Node 24 LTS，然后重新运行安装程序。
- **Node 版本过旧（例如 Node 20）：** 从同一页面安装 Node 24 LTS，确保 Node 24 在 PATH 中排在前面，然后重新运行。常见原因是旧 Node（通常来自 conda 的“base”环境）优先于新版：安装程序会打印找到的所有 Node 副本，以便你确认当前实际使用哪一个。
- **更换 Node 后，安装程序会彻底重装：** 它只删除 TestingPlatform 文件夹内的 `node_modules`，然后重新安装。这是必要的，因为 `pnpm install` 显示“Already up to date”**不能**证明原生绑定存在——切换 Node 后，即使安装提示如此，绑定仍可能缺失。安装程序会检查绑定文件夹，缺失时强制彻底重装。

绝不要删除 `pnpm-lock.yaml`，也绝不要在此仓库中运行 `npm i`。这是 pnpm 仓库。

## 安装程序刻意不做什么

- 不选择或测试模型，不运行任何任务，也不发送归档包。这些是安装准备完成后的独立步骤。
- 不索取、存储或发送任何密码、token、密钥或个人数据。
- 不更改全局 Node、PATH 或 TestingPlatform 文件夹之外的任何文件（唯一例外是在 pnpm 缺失或版本不正确时，全局安装仓库固定的 pnpm 版本；这也是仓库 README 中的命令）。
- 不删除你的文件。唯一删除的是上文所述 Node 版本变化时 TestingPlatform 文件夹内的 `node_modules`。
- 不在 `demo-target/` 内运行任何操作。所有安装和准备命令只从仓库根目录运行。在 `demo-target/` 内启动 harness 会报错“Missing script: dev”——安装程序绝不会这样做。

## 安装准备失败时

1. 阅读安装程序的最后一条消息。它会指出失败的步骤以及可尝试的处理方法。
2. 不要反复运行同一个失败步骤并期待结果自行改变。尤其是，后续出现的提供方或模型错误不属于安装失败——安装程序只验证 harness 能够构建并启动。
3. 报告三项信息：电脑类型（Mac/Windows、芯片）、Node 版本（`node --version`）和安装程序最后几行错误。这些信息通常足以解决问题。
