# Integration validation

Validation updated: 2026-10-26. The current checks ran on Linux with Node.js 24.22.1. The frozen bootstrap installation used pnpm 11.25.0; the repository and launcher pin pnpm 11.28.5. The imported source revisions are recorded in [source-import.json](source-import.json).

## Current verification

The setup invocation completed the artifact build, but memory contention interrupted its aggregate host TypeScript check. The client aggregate check passed, and the host aggregate check subsequently passed when run separately with a bounded heap. The evidence below records the completed checks individually; an uninterrupted `pnpm run setup` invocation has not been demonstrated in this environment.

| Check | Current result |
|---|---|
| Frozen dependency installation | Passed for all 388 workspace projects with `pnpm install --frozen-lockfile`. |
| Harness artifact build | All 8 stages passed; 358 client artifacts produced. |
| Client aggregate TypeScript check | Passed during `build:check`. |
| Host aggregate TypeScript check | Passed separately with `node --max-old-space-size=6144 node_modules/typescript/bin/tsc -p tsconfig.host.json` after the memory-related interruption. |
| Plugin adapter type checking | Passed with the plugin's `typecheck` command. |
| Local profile integration tests | All 6 passed, including profile isolation, local linking, repeated setup, and conflicting installation handling. |
| Native asset restoration | All 8 passed, including complete asset restoration, corruption detection, preserved existing files, and concurrent restoration. See the checksum below. |
| Plugin Text test UI | All 16 focused checks passed. They cover actual reply rendering as plain text, pending/error/empty responses, duplicate prevention, retry behavior, and bilingual first-call guidance. Client copy/style lint passed with 775 used copy keys and 214 style rules. |
| Local provider discovery | Aggregate regressions passed, including keyless discovery and saved base URL overrides for Ollama, LM Studio, and llama.cpp. Registry checks passed for 76 providers and 502 model IDs. |
| Combined application HTTP smoke | Passed: normal authentication, exactly one host plugin and browser plugin, served client JavaScript, managed settings, saved local provider discovery, catalog visibility, one streamed plugin completion with returned text, and orderly shutdown. The Text test request contained no tools. |
| Real browser flow | Passed with a local fixture: first-launch notice, plugin settings and disclaimer, Free models, Text test with a visible reply and timing, workspace selection, model selection, and chat response. Screenshots were visually reviewed; no uncaught browser errors occurred. |
| Optional standalone management application | Started with `--no-refresh`, an automatically assigned port, and private temporary state. The authenticated management HTML returned HTTP 200, and SIGINT shutdown exited with code 0. No provider refresh or model completion was requested. |
| Documentation | All 43 `doc-sync` gates passed. The terminology checker regression suite passed all 64 tests, and its positive check and private temporary-repository negative control passed. |
| Full repository lint | Passed with `DSH_OXLINT_THREADS=1 GOMEMLIMIT=2GiB GOGC=50 NODE_OPTIONS=--max-old-space-size=3072 pnpm run lint`: 0 errors and 6 existing unused-disable warnings (1 experimental CoT source warning and 5 imported channel-pack source warnings). The first scan was interrupted by SIGKILL; the bounded retry completed. |

The browser verification made three generation requests to its loopback fixture: Text test, chat, and automatic session title generation. The chat request advertised 31 available tools; the fixture returned only text and executed no tool calls. Text test and title generation advertised no tools. These checks validate the integrated request path and interface using deterministic responses. They do not establish access to a live external provider, validate a provider account, load real model weights, or test model quality.

Native Windows and macOS execution have not been tested. The smoke's Windows process-tree cleanup follows the repository's `taskkill /T /F` precedent and was source-reviewed; its Linux cleanup regression passed. Optional desktop installers, the native Magpie engine, and every external account/service remain outside this validation scope.

## Historical baseline evidence

The 2026-10-25 baseline recorded passing evidence for all 94 plugin contributor suites. Its initial sweep passed 91; reload passed after host artifacts were built, forwarding passed after removing a public-DNS dependency from its fixture, and source-channel passed after adapting its test to the public host API. Those three suites were rerun individually. The complete 94-suite contributor run was not repeated for the current update; the focused checks above cover the changed UI and local discovery behavior.

The earlier report also recorded 39 subscription checks, 6 OAuth transport checks against local substitutes, generated standalone channel freshness, integration/OAuth documentation checks, and 76 relocated workflow links across 28 Markdown files with 14 bilingual pairing records. These are historical baseline results.

## Source verification and publication

The initial composed source baseline was verified against Git tree `fcc368151aca9587dae1648235742b71346100aa`, including every tracked path, file mode, symlink, and binary asset. That hash identifies the initial baseline. Subsequent setup, documentation, interface, discovery, and native-asset storage changes have the separate validation evidence recorded here. The [import reference](import-notes.md) describes source composition and its exact-tree check.

Repository publication and hosted CI are separate from these local checks. The initial import workflow failed before a runner started, so it supplied no hosted validation evidence. The [TestingPlatform checks](../.github/workflows/testing-platform-ci.yml) workflow is available only through `workflow_dispatch`; no successful GitHub CI run is claimed here. The publication of the reviewed files and the resulting remote commit must be checked separately from this report.

## Preserved native asset

The original `plugins/dsh-our-free-model/vendor/magpie/bin/magpie-win32-x64.exe` is restored byte for byte from the [checksummed archive parts](assets/README.md). Its SHA-256 is `6490f7ed2c5f001adc97284276af453f2a2b1711712e175e6fc780e09046fa3b`. Eight focused restoration tests passed: ordered parts and repeated setup, damaged gzip data, altered archive and executable hashes, missing parts, preserved conflicting files, concurrent restores, and complete bundled asset restoration. These checks did not execute the Windows binary.

## Reproduce the focused checks

Follow the root [setup procedure](../README.md#run), then run these commands from the repository root:

```sh
pnpm run test:integration
pnpm --dir plugins/dsh-our-free-model run typecheck
pnpm run smoke:platform
pnpm run doc-sync
pnpm run lint
```

The integration command includes the 6 profile checks and 8 native restoration checks. Run the changed plugin's focused checks from its directory:

```sh
cd plugins/dsh-our-free-model
node scripts/plugin-bench-ui-test.mjs
node scripts/client-lint.mjs
node scripts/aggregate-test.mjs
node scripts/registry-test.mjs
```

For an independent host aggregate check after building artifacts, run this from the repository root:

```sh
node --max-old-space-size=6144 node_modules/typescript/bin/tsc -p tsconfig.host.json
```

`pnpm run test:plugin` runs the complete contributor suite when a broader rerun is needed. The manual TestingPlatform workflow runs installation, setup, plugin type checking, contributor tests, integration tests, and the HTTP smoke. The browser walkthrough and standalone management-page check above were additional local checks and are not part of that workflow.
