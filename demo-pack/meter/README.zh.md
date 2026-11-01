# Bill-audit 计量工具（演示副本）

[English](README.md) | 中文

仅使用 Node 标准库的统计工具。它不调用模型，而是回放会话导出，统计 agent（智能体）请求数、token、工具调用轨迹，以及按官方标价计算的成本。

## 文件

- `bill-audit.mjs`——统计工具。它从脚本所在目录读取 `prices.json`，因此须将这两个文件放在一起。
- `prices.json`——价格表，版本日期为 2026-10-26。DeepSeek 条目已于 2026-10-26 在 DeepSeek 官方价格页面核验。Kimi 条目经过二手来源交叉检查，尚未经官方核验：向投资者使用这些数据前，须在 Moonshot 官方价格页面重新核验 Kimi 价格。

## 此副本与原版

这是演示副本，也是本次演示使用的权威版本。原版位于 deepseek-harness 仓库的 `scripts/bill-audit/` 中，保持不变。不要同时编辑两个副本；如果价格或规则发生变化，请在这里修改，并在演示记录中注明。

## 运行（由 Cheng 在收到资料后执行）

```sh
node demo-pack/meter/bill-audit.mjs run \
  --input <unzipped-export-folder> \
  --out evidence/<TASK>/<arm> \
  --arm control|treatment --task <TASK> --success true|false
```

完整的保存和比较工作流见 `../SAVE_AND_COMPARE.md`。成本计算约定：输入 token × 缓存未命中单价 + 缓存读取 token × 缓存命中单价 + 输出 token × 输出单价，各单价均以每百万 token 计；缓存写入不单独计费。未知模型归入未定价类别并列出，绝不猜测价格。这些成本是按官方标价折算的等价成本，而非实际账单金额（免费路由的实际费用可能为 $0）；节省百分比才是可用于其他场景的结论，且仅适用于已定价模型。
