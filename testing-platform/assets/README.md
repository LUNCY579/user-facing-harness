# Bundled native asset

English | [中文](README.zh.md)

## Reference

This directory stores the plugin's Windows x64 Magpie engine as ordered gzip parts. The [asset manifest](../native-assets.json) records their sizes, SHA-256 checksums, original source revision, and restored destination. The complete gzip stream preserves the bytes from the recorded archive source; each checked-in part is at most 1 MiB.

Restore or verify the engine from the repository root:

```sh
node testing-platform/restore-native-assets.mjs
```

The command verifies the compressed archive and restored executable, publishes the destination only after both checks pass, and reports `restored` or `verified`. It never executes the Windows binary. It runs under Node.js on Linux, macOS, or Windows; this does not make the Magpie engine itself portable. Provider accounts, channel configuration, and native engine support are separate requirements described in the [plugin guide](../../plugins/dsh-our-free-model/).

An existing executable with different bytes is preserved and stops setup. Move that file aside before retrying. Missing or damaged archive parts stop restoration and remove temporary output; restore this directory and the manifest from Git, then repeat the command. A verified existing executable does not require decompression again.

The restored executable is ignored by Git. Commit the archive parts, manifest, and restoration code together when deliberately updating the bundled asset; the source records remain explicit. The focused checks are available with `node testing-platform/restore-native-assets.test.mjs` and include complete asset restoration without launching it.
