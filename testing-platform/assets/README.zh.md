# 随附原生资源

[English](README.md) | 中文

## 参考

本目录将插件的 Windows x64 Magpie 引擎保存为按顺序排列的 gzip 分卷。[资源清单](../native-assets.json)记录各分卷的大小、SHA-256 校验值、原始源码版本和恢复目标路径。完整 gzip 数据流保留清单中归档来源的原始字节；每个纳入 Git 的分卷不超过 1 MiB。

在仓库根目录恢复或校验引擎：

```sh
node testing-platform/restore-native-assets.mjs
```

该命令校验压缩归档和恢复后的可执行文件，仅在两项校验均通过后创建目标文件，并报告 `restored` 或 `verified`。它不会运行 Windows 二进制文件。该命令可在 Linux、macOS 或 Windows 的 Node.js 下运行；这不代表 Magpie 引擎本身可跨平台运行。提供方账户、渠道配置和原生引擎支持属于独立要求，参见[插件指南](../../plugins/dsh-our-free-model/)。

如果已有可执行文件的内容不同，命令会保留该文件并停止设置。请先将该文件移至其他位置，再重试。缺少或损坏的归档分卷会使恢复停止并删除临时输出；请从 Git 恢复本目录及清单，然后再次运行命令。已有且校验通过的可执行文件无需再次解压。

恢复后的可执行文件由 Git 忽略。有意更新随附资源时，请一起提交归档分卷、清单及恢复代码，并明确保留来源记录。使用 `node testing-platform/restore-native-assets.test.mjs` 可运行针对性检查，其中包含恢复完整资源而不运行它的验证。
