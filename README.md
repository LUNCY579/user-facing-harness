---
description: "Build TestingPlatform, launch DeepSeek Harness with its bundled model plugin, and send your first model request."
---
# TestingPlatform

English | [中文](README.zh.md)

<a id="summary"></a>

## Summary

TestingPlatform lets you run model experiments from the DeepSeek Harness Web interface with the complete **Our Free Model** plugin in the same repository. Install once, launch one application, configure a provider in the plugin, and select its model in the chat composer. The Harness source lives at the repository root; the plugin lives in [`plugins/dsh-our-free-model/`](plugins/dsh-our-free-model/).

<a id="contents"></a>

## Contents

- [Prerequisites](#prerequisites)
- [Run the combined application](#run)
- [Send your first model request](#send-your-first-model-request)
- [Connect your API key or local model](#connect-your-api-key-or-local-model)
- [Enable additional functionality](#enable-additional-functionality)
- [State, credentials, and environment](#state-credentials-and-environment)
- [Troubleshooting](#troubleshooting)
- [Development](#development)

<a id="prerequisites"></a>

## Prerequisites

Install these before cloning. The complete source build includes the Harness browser and desktop packages; using the combined Web interface does not require building a separate plugin desktop installer.

| Requirement | Setup |
|---|---|
| Node.js | **24.9 or newer**, with npm and development headers. A current Node 24 installation is suitable; use the [official download instructions](https://nodejs.org/en/download). |
| Package manager | **pnpm 11.28.5**, pinned in [`package.json`](package.json). |
| Git | **2.26 or newer** and access to this repository. Authenticate with your GitHub account if cloning the private repository requests it. |
| macOS | Install Apple command-line developer tools if absent (`xcode-select --install`). The native addon needs a C compiler and the Node installation’s `include/node/node_api.h`. |
| Linux | Install a C build toolchain (`build-essential` on Debian/Ubuntu) and use a complete Node installation with `include/node/node_api.h`. |
| Windows | Use Node and Git for Windows with PowerShell, or use a separate WSL 2 checkout with Linux tools. Keep the checkout and `node_modules` in the same environment. Optional plugin desktop packaging additionally needs Rust/MSVC. |

If `pnpm` is missing, install the pinned version with npm:

```sh
npm install --global pnpm@11.28.5
node --version
pnpm --version
git --version
```

If you already use Corepack, `corepack enable` lets it select the version declared by this repository. See the [pnpm installation guide](https://pnpm.io/installation) if your Node installation does not include Corepack or your global install needs a user-writable prefix. Keep Node’s TypeScript stripping enabled; remove `--no-experimental-strip-types` from `NODE_OPTIONS` before building.

<a id="run"></a>

## Run

These commands install and launch the combined TestingPlatform profile. Run them from a terminal on the machine that will host the application.

<a id="run-from-source"></a>

### Run from source

```sh
git clone https://github.com/LUNCY579/TestingPlatform.git
cd TestingPlatform
pnpm install --frozen-lockfile
pnpm run setup
pnpm start
```

`setup` builds the application, checks its TypeScript programs, and prepares the local plugin profile. Wait for it to finish successfully before starting. The initial install/build can take several minutes. Setup does not log in to a provider, download model weights, or send a model completion.

`pnpm start` opens the Web interface, normally on `http://127.0.0.1:3080`. If the browser does not open, use the **complete URL printed by the terminal**: it includes the launch token that establishes your browser session. Keep that URL private. The browser and server authenticate through the Harness’s normal session flow.

To choose another port and open the printed link yourself:

```sh
pnpm start --no-open --port 3081
```

Keep the terminal running while using the interface. Press **Ctrl+C** to stop it; run `pnpm start` again to resume with the saved settings and sessions. Installing another copy of the plugin from npm is unnecessary: this profile already links the plugin directly from the checkout.

<a id="send-your-first-model-request"></a>

## Send your first model request

There are two useful first checks: a short text response inside the plugin, followed by an ordinary conversation in Harness. A DeepSeek API key is not required when using an available keyless plugin model or your local inference server. Other providers can require an account, a subscription, or a paid API key; the plugin name does not guarantee free access.

<a id="1-check-a-response-inside-the-plugin"></a>

### 1. Check a response inside the plugin

1. On first launch, choose **Continue** in the Harness preview notice. Open **Settings → Our Free Model**, acknowledge the plugin’s first-use notice (the Chinese confirmation reads **我已阅读并了解**), then select **Free models**. The **Try your first model call** panel describes the same path.
2. Refresh the model list if needed. Choose a currently available model card and click **Text test**. A listed model can still be unavailable from your network or account.
3. Wait for the **Model reply** panel. The test asks the selected model to `Reply with exactly: OK`, shows its actual returned text, and reports timing/token metrics. It sends a real generation request and uses no agent tools. A slow provider can take up to five minutes.
4. If the test fails, read the displayed provider error, check sign-in/quota/network requirements, and try another model or [connect a provider you control](#connect-your-api-key-or-local-model). A successful model listing alone does not establish that generation works.

<a id="2-chat-through-the-harness-interface"></a>

### 2. Chat through the Harness interface

1. Return to the main session view and select the project directory you intend to use in the workspace picker (**Choose workspace** when none is selected). Add the directory if necessary; confirm it instead of relying on an automatically selected default. **The composer requires a selected workspace.**
2. Start a new session. Open the composer’s model selector, expand **Our Free Model**, and select the model you just tested. Provider models added through Aggregate appear with a `provider/model` identifier.
3. Send this small first prompt:

> Reply with exactly: TestingPlatform is connected.

4. Confirm the assistant returns text. Open **Settings → Our Free Model → Request log** to inspect the corresponding model call and any provider errors.
5. After that succeeds, try a workspace task such as “List the top-level files in this workspace without changing them.” Tool use additionally depends on the selected model’s capabilities and the active permission policy; answer any approval prompt deliberately.

<a id="connect-your-api-key-or-local-model"></a>

## Connect your API key or local model

Use **Our Free Model → Aggregate** to route your own provider through the integrated plugin. The separate Harness **Settings → Models** page configures native Harness providers; use Aggregate when you want to exercise this plugin’s routing and logs.

<a id="an-api-provider"></a>

### An API provider

1. Choose **Add provider**, find your provider, and click **Configure**. Entries marked **Not drivable** require an authentication flow this generic API-key route cannot run.
2. Enter its API key and, if necessary, the **Base URL** for your endpoint. Keep the provider enabled.
3. Click **Add** or **Save** first. **Test** and **Discover models** use the server’s saved configuration; they do not use unsaved text in the form.
4. Click **Test** to check the model-listing endpoint, then **Discover models** to populate available model IDs. If discovery is unsupported or empty, enter exact provider model IDs in **Model override**, separated by commas or newlines, and save. An explicit override takes precedence over discovery.
5. Return to Harness, start a session, and choose the provider’s model under **Our Free Model**. Send the short prompt above to verify generation; the provider’s **Test** button checks listing, not a completion.

<a id="a-local-inference-server"></a>

### A local inference server

Install your chosen inference application, load or download a model there, and start its OpenAI-compatible server before configuring Aggregate. TestingPlatform supplies the interface and adapter; it does not install model weights or the inference runtime.

| Aggregate provider | Default base URL | API key |
|---|---|---|
| Ollama | `http://localhost:11434/v1` | Not required by the bundled local configuration. |
| LM Studio | `http://localhost:1234/v1` | Not required by the bundled local configuration. |
| llama.cpp | `http://localhost:8080/v1` | Not required by the bundled local configuration. |
| NVIDIA NIM | `https://integrate.api.nvidia.com/v1` | Required. Enter the key you were given in the provider's API key field; the key is never stored in this repository. See the [NVIDIA NIM endpoint guide](plugins/dsh-our-free-model/docs/nvidia-nim-endpoint.md). |

Follow the same **Configure → Add/Save → Discover models** flow. These entries have no bundled model IDs: discover the running server’s models or save the exact ID in **Model override**. If your server uses another port or authentication, match its settings. `localhost` means the machine/environment running the Harness server, which can differ from the browser’s machine or a Windows host when using WSL.

<a id="enable-additional-functionality"></a>

## Enable additional functionality

The combined profile includes the Harness base tools and plugin management interface. Enable external accounts and optional services only when you need their capability; each still has its own prerequisites. The plugin’s [full guide](plugins/dsh-our-free-model/README_EN.md) owns detailed provider behavior.

| Capability | Where to configure it | What is needed |
|---|---|---|
| Account-backed channels | **Our Free Model → EAC router** | Sign in using that channel’s own flow; enable a supported account/channel and select an available model. |
| Subscription/API accounts | **Our Free Model → Model workspace** | Add the relevant account or authorized credentials; availability and quota depend on that account. |
| Fallback or round-robin models | **Our Free Model → Routing** | Configure usable member models first, save a route, then select its virtual model in the composer. |
| Usage, latency, failures | **Dashboard** and **Request log** | Make model requests; charts and logs reflect actual recorded calls. |
| OpenAI-compatible API for another client | **Free models → Local forward**, then **Gateway → Connect a client** | Enable the forward port, then copy the displayed base URL, key, and model ID into the client. See the steps below. |
| Tool-output compaction and prompt shaping | **Our Free Model → Token savers** | Enable desired options explicitly and compare their effect on your experiments; shaping can change model inputs. |
| Files, commands, plans, subagents | Harness session/workspace | A selected workspace, a suitable model, required host tools, and the active permission policy. See the [Web guide](docs/user/guide/index.md). |
| MCP tools and memory servers | Profile patches | Install/start the external MCP server and configure its command or URL. Follow the [MCP guide](docs/user/guide/mcp-memory.md). |
| Scheduled work | Harness settings/session tools | Configure a working model and the desired schedule; see the [schedule guide](docs/user/guide/schedule.md). |
| Web search and fetch | Harness web providers | Configure the selected provider’s credentials and limits using the [web package guide](packages/web/README.md); anonymous HTTP fetch and provider-backed search have different requirements. |
| Browser/desktop automation | Optional Harness provider bundles | Choose one backend and follow the [browser](packages/browser-use/README.md) or [computer-use](packages/computer-use/README.md) provider guide for browser installation and OS permissions. Some providers are experimental. |
| Remote execution over SSH | Headless/custom profiles | An accessible POSIX host, OpenSSH connection, and remote helper as described in the [SSH guide](packages/ssh/README.md). |
| Operator-hosted EAC gateway | Plugin [`worker/README.md`](plugins/dsh-our-free-model/worker/README.md) | A separately deployed service with your upstream endpoint, authorized key, and signing secrets; configure its hosting before connecting clients. |
| Python automation | [`python/`](python/) | Install the SDK/runtime and choose its executable, profile, and Harness home as described in the [SDK guide](docs/user/guide/python-sdk.md). The bundled Python runtime does not automatically inherit this checkout’s plugin. |
| Separate plugin service or desktop package | Plugin [`PACKAGING.md`](plugins/dsh-our-free-model/PACKAGING.md) | Separate nested dependencies and platform toolchains; these are optional applications, not required for this Web flow. Interpret packaging paths relative to the plugin directory. |

<a id="connect-another-client-through-the-plugin"></a>

### Connect another client through the plugin

1. First verify that a model can answer inside Harness.
2. In **Free models → Local forward**, enable the forward port. It is off by default and initially requests loopback port `18899`; a busy port can cause the listener to choose another one.
3. Open **Gateway → Connect a client**. Copy the **actual bound URL and generated key shown there**, plus a listed model ID. The gateway URL/key are separate from the Harness Web login URL.
4. Configure your client for the displayed compatible API and send a small request. Inspect **Request log** for its result. Keep Harness running while the client uses this forward service.

<a id="gemini-account-configuration"></a>

### Gemini account configuration

Gemini account login/refresh and imported Gemini CLI subscription refresh require matching OAuth client credentials. They are separate integrations:

| Operation | Required secret | Optional matching client ID |
|---|---|---|
| Gemini channel login/refresh | `CMDC_PAK_GOOGLE_CLIENT_SECRET` | `CMDC_PAK_GOOGLE_CLIENT_ID` |
| Gemini CLI subscription refresh | `OFM_GEMINI_CLIENT_SECRET` | `OFM_GEMINI_CLIENT_ID` |

Set the relevant variables before launching, using an OAuth client you are authorized to use. Other providers do not require these variables. Missing secrets produce a configuration error when the corresponding login/refresh is needed; an unexpired imported token may still work until refresh. See the [plugin integration guide](plugins/dsh-our-free-model/TESTINGPLATFORM.md#gemini-oauth-configuration).

The optional bundled **Magpie engine is Windows x64 only**. Its checked-in asset parts are restored with checksum verification during combined launch/setup; restoring the file on another OS does not make the engine runnable there. This limitation does not prevent using other supported plugin providers.

<a id="state-credentials-and-environment"></a>

## State, credentials, and environment

The combined launcher stores profiles, sessions, credentials, and plugin settings under the ignored **`.testingplatform/`** directory in this checkout, unless you export a different `DSH_HOME`. Back up that directory when preserving experiments; deleting it can remove saved sessions and sign-ins. Your normal home-directory Harness installation remains separate.

The active profile is `.testingplatform/profiles/testing-platform/`. Repeating setup preserves existing personal settings. The plugin runs in **managed** mode: its self-updater does not replace repository source. Update source through Git and rerun the frozen install and setup when dependencies or built code change.

Provider values can come from the launching environment or a private `.env`. The CLI reads the repository-root `.env` and `$DSH_HOME/.env` once at startup, with priority **exported environment → repository `.env` → Harness-home `.env`**. A workspace selected later does not change that search. Restart after changing environment files.

Export startup settings such as `DSH_HOME`, `PATH`, and `DSH_*` variables in your shell; they are rejected inside `.env` files. Proxy variables belong in the launching environment or the Harness-home `.env`, not the repository-root `.env`. The [environment reference](packages/boot/app-boot/README.md) and [proxy guide](docs/user/guide/network-proxy.md) cover the exact rules. Never commit API keys, account tokens, or your runtime state.

<a id="troubleshooting"></a>

## Troubleshooting

Use the symptom to choose the next check. The validation commands below use local fixtures; successful checks do not establish that an external provider currently accepts your account.

| Symptom | Check or recovery |
|---|---|
| `pnpm` missing or wrong version | Install the pinned pnpm version above, then verify `pnpm --version` from the repository root. On PowerShell, use `pnpm.cmd` if script policy blocks `pnpm.ps1`. |
| Missing `apps/cli/lib/bin.js` or Web assets | Run `pnpm install --frozen-lockfile`, then `pnpm run setup`. `start` reuses the build instead of silently rebuilding. |
| `Node-API headers missing` or `cc` not found | Install the C toolchain and complete Node distribution for the same environment, then rerun setup. A standalone `node` executable without its headers is insufficient on Linux/macOS. |
| Browser opens but requests fail with 401 | Reopen the complete launch URL printed by the current server to establish its browser session. |
| Port 3080 is occupied | Run `pnpm start --no-open --port 3081` and open its printed URL. |
| Cannot type a message | Select a workspace, start a session, and select an available model. The server’s working directory alone does not select a workspace. |
| Plugin settings or model group is absent | Launch with `pnpm start`, then run `pnpm run config:platform` and `pnpm run smoke:platform`. These verify the combined profile, local host plugin, and served browser module. |
| Aggregate test/discovery fails after editing a key | Click **Add/Save** before **Test/Discover models**. Verify the saved base URL and provider authentication requirements. |
| Local provider shows zero models | Start the inference server with a loaded model; discover its model list or enter an exact model ID override and save. |
| A model is listed but generation fails | Inspect the provider error and Request log. Check account login, quota, geographic/network access, exact model ID, and support for the request’s features. Try a small text-only prompt. |
| Profile exists or its link points elsewhere | Use a separate `DSH_HOME`, or back up and inspect the conflicting profile/link reported by the launcher. Do not delete existing state to repair it blindly. |
| Remote browser cannot connect / receives 403 | Follow the [public deployment guide](docs/user/guide/public-deployments.md) for trusted hosts, URLs, forwarding, and TLS. Loopback defaults are intended for local use. |

<a id="development"></a>

## Development

Run these from the repository root after installation. Use the [development and state reference](testing-platform/README.md) for profile overrides, watcher behavior, independent experiments, and source ownership.

| Command | Purpose |
|---|---|
| `pnpm run setup` | Build/check the application and prepare the combined profile. |
| `pnpm start` | Start the built combined Web application. |
| `pnpm run dev` | Build artifacts, watch Harness browser bundles, and restart the source CLI on imported source changes. |
| `pnpm run config:platform` | Print the effective combined configuration without starting its server. |
| `pnpm run test:integration` | Check profile isolation, linking, repeated setup, conflicts, and native asset restoration. |
| `pnpm run smoke:platform` | Check the combined server and plugin integration with local test fixtures. |
| `pnpm run test:plugin` | Run plugin contributor tests against local substitutes. |

The original Harness packages, CLI modes, Python SDK, documentation, and tests remain available. See the [Harness development guide](docs/development.md), [architecture](docs/architecture.md), and [plugin integration notes](plugins/dsh-our-free-model/TESTINGPLATFORM.md). Optional upstream apps and profiles have their own compositions; `pnpm start` is the entry that selects this repository’s integrated Web profile.

<a id="developer-preview"></a>

## Developer preview

DeepSeek Harness is a developer preview with evolving APIs and session formats. Review its [safety notice](SAFETY.md) before allowing agents to operate on important projects. Use the [validation record](testing-platform/VALIDATION.md) for the checks run on this integration and their limits; external account access and native platform behavior require verification in your own environment.

<a id="contributing"></a>

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). For agent-assisted changes, follow [AGENTS.md](AGENTS.md). The [source-import record](testing-platform/source-import.json) identifies the two imported snapshots; their original licenses and attribution remain in the repository.

<a id="citation"></a>

## Citation

DeepSeek Harness is developed by [DeepSeek AI](https://deepseek.com) on [Cordis](https://github.com/cordiverse/cordis). Preserve its citation when publishing work that uses it:

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

<a id="license"></a>

## License

Harness: [MIT](LICENSE). Plugin: [MIT](plugins/dsh-our-free-model/LICENSE). See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the plugin’s vendored notices for bundled dependencies.

<a id="dev-note"></a>

## Dev Note

None.
