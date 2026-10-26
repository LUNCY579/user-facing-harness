---
kind: upgrade-guide
description: "TestingPlatform's imported Our Free Model plugin requires operator-supplied Gemini OAuth client secrets for login and token refresh."
---
# Configure Gemini OAuth in TestingPlatform

English | [中文](guide.zh.md)

## Change

The Our Free Model plugin imported into TestingPlatform requires environment-provided Google OAuth client secrets. Its original JavaScript source embedded client secrets for the Gemini account channel and imported Gemini CLI subscriptions. This affects users of those two plugin integrations; the harness version and other providers do not change.

Public client IDs remain as defaults. Missing channel configuration rejects login before opening a callback listener. Missing subscription configuration returns `OAUTH_NOT_CONFIGURED` when token refresh is required; an unexpired access token remains usable. The original bundled Magpie Windows executable is preserved and is outside this JavaScript configuration change.

## Migration

1. For Gemini account channel login and refresh, set `CMDC_PAK_GOOGLE_CLIENT_SECRET` in the environment that launches TestingPlatform. If using a different authorized OAuth client, also set the matching `CMDC_PAK_GOOGLE_CLIENT_ID`.
2. For imported Gemini CLI subscription refresh, set `OFM_GEMINI_CLIENT_SECRET` and, if needed, the matching `OFM_GEMINI_CLIENT_ID`. The two integrations have different default client IDs; use the secret matching each client. Keep these values outside committed files.
3. Restart the integrated harness. Reconnect the relevant Gemini account or refresh its subscription quota to confirm the configuration is accepted. This confirmation uses the provider's network service; offline regression checks use test credentials.

See the [plugin integration guide](../../../../plugins/dsh-our-free-model/TESTINGPLATFORM.md) for local development and rebuild commands.
