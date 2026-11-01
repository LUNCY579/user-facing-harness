# demo-target

[English](README.md) | 中文

这是一个小型、独立、无依赖的 Node.js 项目。它只有一个用途：作为 WING 预测工具演示的固定工作区。同一项任务分别在关闭预测工具（对照组）和开启预测工具（实验组）的情况下各运行一次，再使用 `deepseek-harness/scripts/bill-audit/` 中的 bill-audit 统计工具比较两次运行。

它不是产品，也不需要为其自身目的进行改进。下文列出的每个特殊行为都是有意设置的，并且各自对应一项演示任务。

## 运行

```sh
npm test
```

`npm test` 执行 `node --test --test-concurrency=1 test/*.test.js`。并发限制是必需条件：它使测试文件按确定的字母顺序运行，从而让 T7 中仅在完整测试套件中出现的失败能够稳定复现，而非取决于竞争时序。（在 Node 24 上，单独使用 `node --test test/` 目录参数不会运行此套件——请使用上面的 glob 形式。）

CLI（命令行界面）：

```sh
node src/cli.js greet Ada        # prints: User: Ada
node src/cli.js --help
```

CLI 的 greet 命令使用 `src/util.js` 中的 `formatUser()`。

## 文件

- `src/parse.js`——解析 `HDR:<number>\n<body>` 文本。
- `src/util.js`——辅助函数，包括 `sumRange()` 和 `formatUser()`。
- `src/cli.js`——小型 CLI（greet 和 help）。
- `src/retry.js`——重试辅助函数。
- `src/fetch.js`——带重试的 fetch 辅助函数。
- `src/registry.js`——使用磁盘文件保存状态的小型事件注册表。
- `test/*.test.js`——无依赖的 `node:test` 测试套件。

## 原始状态（判定运行结果前请先阅读）

刚检出的完整测试套件中恰有两个测试失败，这是有意设置的——它们对应两项不同的演示任务：

1. `test/util.test.js`——`sumRange` 在 `end` 前少执行一次，因此 `sumRange(1, 3)` 返回 3，而非 6。这是任务 T2（修复失败测试，但不得修改任何测试文件）。
2. `test/registry-b.test.js`——注册表测试假设注册表为空，但 `test/registry-a.test.js` 已经向 `src/registry.js` 使用的磁盘文件写入了状态。此测试在重置后单独运行时通过，仅在完整测试套件中失败。这是任务 T7（诊断仅在套件中出现的失败，修复问题，并编写 FIX.md）。

需要明确说明：任务 T2 的“测试套件全部通过”判定标准与 T7 的修复存在重叠。agent（智能体）如果只修复 `sumRange`，完整测试套件中仍会留下注册表测试失败；如果使整个套件通过，就修复了这两个问题。判定 T2 时，应检查 `sumRange` 测试是否通过且没有修改测试文件；判定 T7 时，应检查 FIX.md 是否指出根因是共享的磁盘注册表状态，而非只看整个套件通过还是失败。

原始测试套件中的其他测试均通过。以下行为也被有意省略，每项各自对应一项任务：

- CLI 没有 `--json` 标志，帮助中也未提及该标志（T3）。
- 没有名称验证：空名称和超过 100 个字符的名称均按原样格式化（T4）。
- `src/retry.js` 和 `src/fetch.js` 中的重试循环重复；尚无共享辅助函数（T5）。
- `src/parse.js` 实现了解析器错误路径（空输入、格式错误的头部、截断的正文），但尚无相应测试（T6）。
- `FINDINGS.md` 尚不存在（T1：编写它）。
- `FIX.md` 尚不存在（T7：编写它）。
- 所有地方都使用 `formatUser` 这个名称，包括本 README（T8：在所有地方重命名它，包括文档和测试，并且不留下任何旧名称引用；新名称在任务提示词中给出，原始代码库刻意不包含该名称）。

## 重置规则（每次运行前）

```sh
git checkout -- . && git clean -fd
```

也可以重新复制原始文件夹。绝不能让一次运行的修改，或留下的 `.demo-registry.json` 状态文件，影响下一次运行。该状态文件刻意不在 gitignore 中，因此 `git clean -fd` 会将其删除；如果忽略它，重置操作便会在无提示的情况下失效，使 T7 的失败状态影响后续运行。
