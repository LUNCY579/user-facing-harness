---
kind: upgrade-guide
description: "TestingPlatform 导入的 Our Free Model 插件要求由操作者提供 Gemini OAuth 客户端密钥，用于登录和令牌刷新。"
---
# 在 TestingPlatform 中配置 Gemini OAuth

[English](guide.md) | 中文

## 变更

TestingPlatform 导入的 Our Free Model 插件要求通过环境变量提供 Google OAuth 客户端密钥。原 JavaScript 源码内嵌了 Gemini 账号渠道及导入的 Gemini CLI 订阅所用的客户端密钥。此变更只影响使用这两项插件集成的用户；宿主版本和其他提供商不变。

公开客户端 ID 仍保留为默认值。缺少渠道配置时，登录会在打开回调监听器之前被拒绝。缺少订阅配置时，需要刷新令牌的操作返回 `OAUTH_NOT_CONFIGURED`；尚未过期的访问令牌仍可使用。原有 Magpie Windows 可执行文件保持不变，不在此次 JavaScript 配置变更范围内。

## 迁移

1. 使用 Gemini 账号渠道登录和刷新功能时，在启动 TestingPlatform 的环境中设置 `CMDC_PAK_GOOGLE_CLIENT_SECRET`。如使用另一个有权使用的 OAuth 客户端，同时设置匹配的 `CMDC_PAK_GOOGLE_CLIENT_ID`。
2. 使用导入的 Gemini CLI 订阅刷新功能时，设置 `OFM_GEMINI_CLIENT_SECRET`，并按需设置匹配的 `OFM_GEMINI_CLIENT_ID`。两项集成的默认客户端 ID 不同；请分别使用对应的密钥。不要将这些值提交到仓库。
3. 重启集成后的宿主。重新连接相应的 Gemini 账号或刷新其订阅配额，确认配置被接受。此项确认会访问提供商的网络服务；离线回归检查使用测试凭据。

本地开发和重新构建命令见[插件集成说明](../../../../plugins/dsh-our-free-model/TESTINGPLATFORM.md)。
