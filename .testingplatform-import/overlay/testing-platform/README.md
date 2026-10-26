# TestingPlatform

English | [中文](README.zh.md)

TestingPlatform keeps the complete DeepSeek Harness application at the repository root and the complete Our Free Model plugin under [`plugins/dsh-our-free-model`](../plugins/dsh-our-free-model/). One pnpm workspace installs both, and the combined launcher loads the local plugin into the Harness Web profile.

## Set up and launch

Use Node.js 24.9 or later and pnpm 11.28.5, the version pinned in the root `package.json`. A complete Node installation with development headers and a C compiler is required for the Harness native addon on Linux and macOS. Install Apple's command-line tools on macOS or a C build toolchain on Linux if they are absent. The first build covers the full upstream application, including its desktop and browser packages.

```sh
git clone https://github.com/LUNCY579/TestingPlatform.git
cd TestingPlatform
pnpm install --frozen-lockfile
pnpm run setup
pnpm start
```

`setup` builds and checks the Harness, then prepares the `testing-platform` profile. `start` runs the built CLI and opens its Web interface, normally on `http://127.0.0.1:3080`. The plugin contributes its own model management interface to that application. To use another port or suppress opening a browser:

```sh
pnpm start --no-open --port 3081
```

Setup does not sign in to a provider or submit a model request. Provider availability, account requirements, and any provider usage charges still depend on the chosen channel; the plugin's original name does not guarantee that every provider will always be free. See its [documentation](../plugins/dsh-our-free-model/) and the Harness [safety notice](../SAFETY.md) for their operating details.

## Develop and inspect

| Command | Purpose |
|---|---|
| `pnpm run setup` | Build and type-check the full Harness, then prepare the combined profile. |
| `pnpm start` | Launch the previously built combined application. |
| `pnpm run dev` | Build artifacts, watch the Harness browser bundles, and restart the source CLI when its imported host/plugin files change. |
| `pnpm run config:platform` | Print the effective combined Cordis configuration without starting the server. |
| `pnpm run test:integration` | Check local profile isolation, linking, repeat setup, and collision handling. |
| `pnpm run test:plugin` | Run the plugin's contributor test suite. |
| `pnpm run smoke:platform` | Boot a temporary combined Web profile and check the host API and served browser plugin without requesting a model completion. |

The original Harness scripts, packages, tests, native sources, Python SDK, and documentation remain available. `pnpm dsh web` runs the original Harness profile; use `pnpm start` for the combined TestingPlatform profile. Plugin JavaScript is loaded from its local directory. Its standalone, desktop, worker, documentation, and tests are retained under that same directory; their nested application toolchains retain their own upstream manifests.

The plugin's browser entry is already JavaScript. After editing it, refresh the browser; restarting `pnpm run dev` also reloads the host's client-module metadata. The development command uses the existing Harness browser watcher for its TypeScript/TSX client packages. Stop development with Ctrl+C before rerunning dependency installation or a complete setup.

## Local state and configuration

The launcher uses `.testingplatform/` in this checkout as `DSH_HOME` unless you explicitly set that variable. Git ignores this directory, which contains profiles, credentials, sessions, plugin settings, and other runtime data. A normal Harness installation in your home directory is therefore independent of this checkout. To keep multiple experiments separate, set a different `DSH_HOME` for each process using your shell's environment syntax.

The generated profile lives under `$DSH_HOME/profiles/testing-platform/`. Its `package.json` selects the Harness base bundle, Web application bundle, and local plugin exactly once. Its `node_modules/dsh-our-free-model` entry links directly to this repository. The link is a directory junction on Windows. Existing profile manifests and personal `cordis.patch.yml` overrides are preserved on repeated setup; a conflicting profile or plugin installation is reported instead of replaced.

[`managed.patch.yml`](managed.patch.yml) sets `distribution: managed`. This tells the plugin that Git owns its files, so its self-updater, upstream announcement polling, and self-reloader stay inactive. To update the plugin, review and commit source changes in this repository. The plugin remains named `dsh-our-free-model`, and its bundle uses the bare package name so the Harness also discovers and serves its browser entry.

Upstream telemetry is disabled by default for the combined launcher. An explicitly supplied `DSH_TELEMETRY_DISABLED` value takes precedence. The launcher otherwise preserves the Harness's normal authentication and runtime behavior.

## Troubleshooting

- **Missing dependencies:** run the frozen install before setup. The plugin is a local workspace dependency; installing a second copy from npm is unnecessary.
- **Missing built artifacts:** run `pnpm run setup`. Running `start` does not silently rebuild.
- **Missing Node-API headers:** use a complete Node distribution that includes `include/node/node_api.h`, then rerun setup.
- **A profile already exists or its local link points elsewhere:** select a different `DSH_HOME`, or back up the reported conflicting profile/link before recreating it. The launcher preserves that existing data.
- **Port already occupied:** choose another port with `pnpm start --port 3081`.
- **Plugin appears in the host but its page is missing:** run `pnpm run smoke:platform`; it separately checks the browser module graph, the served client bundle, and the authenticated host API.

## Source and licenses

The source-import record and import instructions in this directory identify the exact source snapshots. The Harness [MIT license](../LICENSE), plugin [MIT license](../plugins/dsh-our-free-model/LICENSE), and their third-party notices remain with the imported files. Original repository URLs inside upstream documentation and package metadata retain their attribution and support meaning.
