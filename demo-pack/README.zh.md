# 演示参与者资料包——请先阅读

[English](README.md) | 中文

你是成本演示的对照组。请使用当前检出目录中已有的 harness，在关闭预测工具的情况下，每项任务只运行一次。每项任务向 Cheng 提交一个归档包。不要安装预测器，也不要重复运行任何任务。你无需运行计量工具——Cheng 会在收到资料后运行——但计量工具位于本资料包的 `meter/` 中，因此演示所需内容都在当前检出目录中，无需克隆第二个仓库。

## 资料包包含什么

- `TASKS.md`——8 项固定任务。提示词文本固定，须原样粘贴。此副本包含原始目标状态说明，解释如何判定“测试套件全部通过”（见 TASKS.md 中的“Pristine demo-target note”）。不要编辑此文件。
- `PARTICIPANT_CHECKLIST.md`——逐步操作顺序，涵盖每次运行前、运行中、运行后，以及发送前的敏感内容清理。
- `RUN_SHEET_TEMPLATE.md`——每项任务复制一份，填写后放入该任务的归档包。统计工具无法判断任务是否成功；这由你判断。
- `preflight.mjs`——仅使用 Node 标准库的检查程序，在压缩归档包文件夹前运行。它会检查文件缺失、运行记录表字段为空、残留的 `<...>` 占位符、禁止提交的文件（`.env`、密钥），以及不是 ZIP 或为空的会话导出文件。它不会读取导出 ZIP 内部来查找秘密信息（无法通过这种方式搜索压缩内容）——仍须按照清单手动检查 ZIP 内容。
- `fill_run_sheet.py`——仅使用 Python 标准库的辅助程序，根据解压后的会话导出填写运行记录表：UTC 开始时间（首个提示词事件）、UTC 结束时间（最后一个 `turn/end` 事件，而非 `/export` 命令时间）、模型 ID，以及是否包含用量和工具块。需要人工判断的字段（成功与否、判定标准、权限、输出上限、提交、原始状态检查、重置、预检）仍由你填写。用法：`python3 demo-pack/fill_run_sheet.py --export <unzipped-export> --task <TASK> --participant <code> --out run-sheet.md`。也可以手动填写记录表；脚本只是快捷方式。
- `meter/`——bill-audit 统计工具（`bill-audit.mjs` 和 `prices.json`，价格表日期为 2026-10-26）。这是演示副本，也是本次演示使用的权威版本；原版位于 deepseek-harness 仓库中，保持不变。不要同时编辑两个副本。Cheng 会在收到资料后运行它；你也可以对自己的归档包运行它以自查。Cheng 如何保存和比较运行结果，见 `SAVE_AND_COMPARE.md`。
- `SAVE_AND_COMPARE.md`——Cheng 收到资料后的工作流，包括证据目录布局、计量与比较命令，以及成对结果的比较方式（相同任务、相同模型，每个数值旁都标明是否成功）。参与者无需执行此流程；此文件保留在这里，使整个演示工作流集中在一处。

## 工作区（务必设置正确）

- agent（智能体）的工作区是当前检出目录中的 `demo-target/`，且只能是该文件夹。绝不要让 harness 使用个人项目、工作仓库或任何包含凭据的文件夹。
- harness 本身从 TestingPlatform 仓库根目录启动（在那里运行 `pnpm run dev`），而非从 `demo-target/` 内启动——在 `demo-target/` 内运行会报错“Missing script: dev”。
- 每次运行前，都须在 `demo-target/` 内执行重置：

```sh
git checkout -- . && git clean -fd
```

也可以重新复制原始文件夹。一次运行的修改，以及留下的 `.demo-registry.json` 状态文件，绝不能影响下一次运行。

- 原始状态检查（在第一项任务前执行一次，然后再次重置）：在 `demo-target/` 中运行 `npm test`，必须得到 **10 pass / 2 fail**——两个预设失败分别是 `sumRange` 和仅在完整测试套件中失败的注册表测试。如果结果不同，请停止并告知 Cheng；不要在非原始状态的目标目录上执行任务。

## 按顺序执行一项任务

1. 重置 `demo-target/`。
2. 在 harness 中打开工作区，且只选择 `demo-target/`。
3. 从 `TASKS.md` 原样粘贴任务提示词。运行中不要指导、纠正或重新发送提示词。如果任务停滞，请停止并将此次运行标记为失败——不要介入补救后将其报告为成功。
4. 导出会话（在 Web UI 中使用 `/export`），并下载 ZIP。
5. 复制 `RUN_SHEET_TEMPLATE.md`，完整填写后，以 `run-sheet.md` 保存到归档包文件夹。开始时间、结束时间和模型字段可用 `fill_run_sheet.py` 填写（见上文）。运行记录表中的结束时间是最后一个 `turn/end` 事件的时间，而非稍后的 `/export` 命令时间。
6. 在 `demo-target/` 中保存运行后的状态：执行 `git diff > demo-target-diff.txt`，并追加 `git status --short` 的输出。（对于 T1，单独执行 `git diff` 会为空，因为 FINDINGS.md 是新文件——它会显示在状态行中。这属于预期情况。）
7. 对归档包文件夹运行预检（见下文）。
8. 按照 `PARTICIPANT_CHECKLIST.md` 手动清理敏感内容，然后将三个文件压缩为 `<participant-code>-<TASK>-control.zip` 并发送。在 macOS 上，须排除 Finder 元数据或先将其删除：`zip -r <participant-code>-<TASK>-control.zip <TASK>-control -x "*.DS_Store"`。第一批次的顺序：先发送 T1，等 Cheng 检查后再发送 T2–T8。

归档包文件夹在压缩前只能包含以下三个文件：

```
<TASK>-control/
  session-export.zip
  run-sheet.md
  demo-target-diff.txt
```

## 预检

在当前检出目录中运行（Node 24+；无需安装，无依赖）：

```sh
node demo-pack/preflight.mjs --bundle <TASK>-control [--task <TASK>]
```

退出码为 0 表示归档包结构通过检查（仍会打印警告，必须阅读）。退出码为 1 表示需要修复列出的错误并重新运行。预检通过不代表导出内容没有敏感信息——它无法检查 ZIP 内部。仍须执行手动检查。

## Cheng 收到资料后做什么

他会用 `meter/` 中的 bill-audit 统计工具处理导出内容（请求数、工具调用轨迹、token，以及已知模型价格对应的官方标价成本），检查运行记录表是否完整，将运行结果保存到 `evidence/<TASK>/control/`，然后才将其计为证据。不完整的归档包会退回；他不会猜测缺失字段。失败运行即使更便宜也不算获胜——是否成功由运行记录表判定，并标在每个数值旁。随后，他会使用同一模型、开启预测工具，亲自运行相同任务并比较成对结果，详见 `SAVE_AND_COMPARE.md`。未定价模型只比较工具调用数和 token，绝不在没有价格依据时换算成美元。
