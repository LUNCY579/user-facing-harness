---
description: "Develop the combined TestingPlatform checkout, manage its isolated profile, and inspect local integration checks."
---
# TestingPlatform development reference

English | [中文](README.zh.md)

<a id="summary"></a>

## Summary

Use this reference after the [root README’s setup and first-call tutorial](../README.md). It explains where to make changes, how the combined profile stores settings, and how to validate the Harness-to-plugin integration.

<a id="contents"></a>

## Contents

- [Repository layout](#repository-layout)
- [Development loop](#development-loop)
- [Profiles and isolated experiments](#profiles-and-isolated-experiments)
- [Integration checks](#integration-checks)
- [Optional applications](#optional-applications)
- [Source and licenses](#source-and-licenses)

<a id="repository-layout"></a>

## Repository layout

The root pnpm workspace installs the Harness and plugin together. Each application’s source and optional toolchain retain their own files.

| Location | Responsibility |
|---|---|
| [`apps/`](../apps/) and [`packages/`](../packages/) | Harness CLI, Web/desktop applications, tools, services, and clients. |
| [`plugins/dsh-our-free-model/`](../plugins/dsh-our-free-model/) | Complete plugin, provider adapters, browser UI, standalone/desktop source, worker, and tests. |
| [`launcher.mjs`](launcher.mjs) | Combined setup, start, development, and configuration commands. |
| [`profile.mjs`](profile.mjs) and [`profile.json`](profile.json) | Checkout-local Harness home and one local plugin bundle. |
| [`managed.patch.yml`](managed.patch.yml) | Repository-owned plugin update behavior. |
| [`assets/README.md`](assets/README.md) | Checksummed parts and restoration of the optional Windows engine. |
| [`python/`](../python/) | Python SDK and runtime carrier. |

<a id="development-loop"></a>

## Development loop

After the initial frozen install and setup, start the combined development command:

```sh
pnpm run dev
```

This builds artifacts, watches the Harness browser bundles, and launches the source CLI with the TestingPlatform profile. Imported host/plugin source changes restart that CLI through Node’s watcher. The existing Harness watcher rebuilds its TypeScript/TSX client packages. Stop the process with Ctrl+C before reinstalling dependencies or running a complete setup.

The plugin’s `client.js` is already browser JavaScript. Refresh after editing it; if the running host still advertises cached client-module metadata, restart the development command and refresh again. Edit the local plugin instead of installing a second npm copy. After changing generated channel sources, follow the regeneration commands in the [plugin integration guide](../plugins/dsh-our-free-model/TESTINGPLATFORM.md#regenerating-channel-bundles).

`pnpm start` uses built Harness assets and does not rebuild them. Rerun `pnpm run setup` after dependency or build-input changes when you want to use that command. The original `pnpm dsh web` launches the upstream Web profile; it does not select the combined profile automatically.

<a id="profiles-and-isolated-experiments"></a>

## Profiles and isolated experiments

The generated profile is `$DSH_HOME/profiles/testing-platform/`. Its `package.json` selects the Harness base bundle, Web application bundle, and `dsh-our-free-model` exactly once. Its `node_modules/dsh-our-free-model` link points directly to this checkout; Windows uses a directory junction. Existing profile manifests and personal `cordis.patch.yml` overrides are preserved on repeated setup. A conflicting profile or plugin installation fails with its path instead of being replaced.

Personal overrides belong in that profile’s `cordis.patch.yml`; preserve existing entries when adding a patch. An additional `--patch` argument can load an experiment-specific file; place it before application flags such as `--no-open` or `--port`, because the CLI stops parsing its own options when application arguments begin. Register the plugin only once: the selected bundle already supplies its Cordis entry. See the [CLI profile reference](../apps/cli/README.md) for patch composition.

To isolate another experiment, export `DSH_HOME` before starting. The path below remains under the ignored runtime directory but keeps its profiles, sessions, and credentials separate.

macOS/Linux:

```sh
export DSH_HOME="$PWD/.testingplatform/experiment-a"
pnpm start --no-open --port 3081
```

PowerShell:

```powershell
$env:DSH_HOME = Join-Path (Get-Location) '.testingplatform/experiment-a'
pnpm start --no-open --port 3081
```

Use a fresh terminal or remove that environment override when returning to the default experiment. Sharing one home between concurrent experiments also shares credentials and configuration. Environment-file loading and startup-variable restrictions are documented in the [root README](../README.md#state-credentials-and-environment).

Managed mode disables the plugin’s upstream self-updater, announcement polling, and self-reloader so experimental source stays under Git control. Combined setup/start/development also restore the optional native asset from its verified local parts. The launcher disables upstream telemetry by default; an explicitly exported `DSH_TELEMETRY_DISABLED` value takes precedence. Normal Harness authentication and permission behavior remain active.

<a id="integration-checks"></a>

## Integration checks

Run focused checks after building the current checkout:

```sh
pnpm run test:integration
pnpm run smoke:platform
pnpm run test:plugin
```

The profile checks cover isolation and local linking. The smoke test starts a temporary combined Web profile, verifies its authenticated host/browser plugin, registers a local OpenAI-compatible test provider, discovers its model, and checks a streaming reply through the plugin. It does not validate a real external model or account. Contributor tests use local substitutes; `npm run selftest` inside the plugin is a separate live-provider operation.

For a configuration-only inspection, run `pnpm run config:platform`. See [VALIDATION.md](VALIDATION.md) for recorded results and platform/provider limits. The [Harness testing guide](../docs/testing.md) owns broader tests, and the [development guide](../docs/development.md) owns build and type-check behavior.

<a id="optional-applications"></a>

## Optional applications

The combined Web profile is the primary way to test the Harness and plugin together. The retained plugin standalone/desktop applications are separate entry points with separate data directories; they do not show the Harness workspace/session interface.

The plugin includes prebuilt standalone Web assets. After the root workspace installation, its independent service can use them:

```sh
node plugins/dsh-our-free-model/packages/standalone/cli.mjs --data-dir .testingplatform/standalone
```

Open the complete management URL printed by that process; its normal requested port is `18900`, and the bound port may differ. Stop it with Ctrl+C. The explicit data directory above avoids mixing this trial with a normal standalone installation. The [packaging guide](../plugins/dsh-our-free-model/PACKAGING.md) describes its service, Windows desktop toolchain, installer, and verification requirements.

For packaging instructions in this combined checkout, the root `pnpm install --frozen-lockfile` replaces the upstream plugin-root `npm ci` step: this plugin uses local `workspace:*` dependencies. Nested standalone and desktop build dependencies retain their own lockfiles and still need their documented installation steps. Run plugin-relative packaging paths from `plugins/dsh-our-free-model/`. Building or validating a native Windows installer requires a Windows build machine; running the Web application does not.

The [Python SDK guide](../docs/user/guide/python-sdk.md) explains its runtime and explicit Harness-home selection. Its bundled runtime has its own profiles; select/configure the intended runtime and plugin composition instead of assuming it inherits the running TestingPlatform Web process.

<a id="source-and-licenses"></a>

## Source and licenses

The [source-import record](source-import.json) and [import notes](import-notes.md) identify the pinned snapshots and integration decisions. The Harness [MIT license](../LICENSE), plugin [MIT license](../plugins/dsh-our-free-model/LICENSE), and third-party notices remain with the imported files. The [native asset reference](assets/README.md) records the original executable and checksum-preserving archive representation.

<a id="dev-note"></a>

## Dev Note

None.
