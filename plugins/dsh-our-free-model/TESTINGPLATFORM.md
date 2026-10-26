# Our Free Model in TestingPlatform

This directory contains the complete Our Free Model plugin, its standalone service, desktop source, worker, tests, and bundled assets imported from `LUNCY579/dsh-our-free-model` at `e164fea59e0293ab6284fd62d25d3ab8a4f459ce` (version 2.7.1). Its MIT license and the vendored notices remain with their code.

## Development

Install dependencies from the TestingPlatform repository root with `pnpm install`. The plugin uses the harness packages in this checkout through workspace dependencies; do not install the same-named package from npm. The plugin entrypoints are already JavaScript. Launch the integrated harness using the commands in the [TestingPlatform README](../../README.md).

The integrated profile sets `distribution: managed`. This disables upstream self-updates, announcement polling, and hot reload that could replace experimental source. Restart the development harness after editing plugin code. Register the plugin once: a profile bundle already inserts its Cordis entry and must not be duplicated in a second patch.

The contributor suite loads the compiled harness APIs. From the repository root, build those artifacts before running the plugin checks:

```sh
pnpm run build:artifacts
pnpm --dir plugins/dsh-our-free-model run typecheck
pnpm --dir plugins/dsh-our-free-model run test:contributor
```

Contributor mode checks code against local substitutes without consuming model quota. The original release checks and signed manifests describe the upstream distribution; they do not attest to this modified checkout. `npm run selftest` is a separate live-provider operation.

## Gemini OAuth configuration

TestingPlatform does not embed Google OAuth client secrets in its JavaScript or TypeScript source or generated channel bundles. The two Gemini integrations use different OAuth clients, so each requires the secret matching its own client ID. Public client IDs remain as defaults and can be overridden for a configured client.

| Integration | Required environment variable | Optional matching client ID override |
|---|---|---|
| Gemini account channel login and refresh | `CMDC_PAK_GOOGLE_CLIENT_SECRET` | `CMDC_PAK_GOOGLE_CLIENT_ID` |
| Imported Gemini CLI subscription refresh | `OFM_GEMINI_CLIENT_SECRET` | `OFM_GEMINI_CLIENT_ID` |

Set the relevant variables in the environment that launches TestingPlatform, using credentials for an OAuth client you are authorized to use. Do not commit them. An unset channel secret stops login before a callback listener opens. An unset subscription secret stops token refresh before a provider request and returns `OAUTH_NOT_CONFIGURED`; an existing unexpired access token remains usable. Neither setting is needed to load the harness or use other configured providers.

The preserved `vendor/magpie/bin/magpie-win32-x64.exe` is the original upstream Windows binary; these JavaScript configuration changes do not rebuild or alter it. Its platform availability and build metadata remain in `vendor/magpie/engine.json`.

## Regenerating channel bundles

After editing `vendor/channel-pack/src/`, regenerate both runtime copies from the repository root:

```sh
pnpm --dir plugins/dsh-our-free-model run channel-pack
pnpm --dir plugins/dsh-our-free-model run build:standalone-channels
```

Keep `vendor/channel-pack/qoder-auth-wasm.wasm` beside the generated `pack.js`. The standalone and Tauri applications retain their original internal layout; see [PACKAGING.md](PACKAGING.md) for their separate build steps. The plugin's nested `package-lock.json` records its original standalone dependency tree; the combined development workspace uses the root `pnpm-lock.yaml`.
