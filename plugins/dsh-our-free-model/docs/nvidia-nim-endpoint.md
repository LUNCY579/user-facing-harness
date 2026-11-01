# NVIDIA NIM custom endpoint

This is the custom API endpoint for NVIDIA NIM in TestingPlatform.
It uses the Aggregate lane's existing provider entry, so no harness
core change is needed.

## Provider entry (already in the repo)

- Provider: **NVIDIA NIM**, id `nvidia_nim`
- Registry: `plugins/dsh-our-free-model/src/providers/registry.json`
- Default base URL: `https://integrate.api.nvidia.com/v1`
- Models listing: `https://integrate.api.nvidia.com/v1/models`
- Wire format: OpenAI-compatible chat completions
- API key environment name: `NVIDIA_NIM_API_KEY` (local use only)

The registry also bundles 8 model ids as a fallback. That bundled
list is **not** a restriction.

## Entering fields (what participants do)

1. Start TestingPlatform (`pnpm run dev` from the repo root).
2. Go to **Settings → Our Free Model → Aggregate**.
3. Choose **Add provider**, find **NVIDIA NIM**, click **Configure**.
4. Enter the API key you were given in the **API key** field.
   Keep the default base URL unless you were told otherwise.
   Keep the provider enabled.
5. Click **Add** or **Save** first. Test and Discover use the saved
   configuration, not unsaved text in the form.
6. Click **Test** (checks the model-listing endpoint, not a
   completion), then **Discover models**.
7. Start a session, open the composer model selector, expand
   **Our Free Model**, and pick the NIM model you tested.

## All free models available

After Discover, the discovered list is what the picker offers
(`plugins/dsh-our-free-model/src/aggregate.js`: a discovered list
takes precedence over the bundled registry list). If Discover is
empty, enter exact model ids in **Model override**, separated by
commas or newlines, and save; an explicit override takes precedence
over discovery.

So: **every model returned by `GET /v1/models` for your key is
selectable.** Nothing in this repo caps the choice to the 8 bundled
ids. "Free" is an account property, not something the listing
labels: check the model on build.nvidia.com and your account
before running a model you have not priced. Free-tier rate limits
are per account, and a key shared across participants shares one
limit pool.

## Key handling (read this before you share anything)

- The key holder sends the key to participants through other
  channels, never through this repository and never in chat
  messages that get pasted into a bundle.
- Never commit a key, a `.env` containing a key, or a settings
  dump containing a key. This repository is public.
- A participant's local settings may hold the key. Before sending
  any session export or bundle, scrub it: if any API key, token,
  password, or home path appears, do not send it.
- To rotate: the key holder issues a new key, tells participants
  to re-enter it in the same Configure form, and revokes the old
  one. No code change is needed.

## Checking a model before a task (do this, not just a text test)

The provider Test button checks listing only. A short text test
("Reply with exactly: OK") checks generation only. Tasks use
tools, and NIM models vary on tool calling, so run a tool test
first:

```sh
NVIDIA_NIM_API_KEY=... node demo-pack/nim-endpoint.mjs --list
NVIDIA_NIM_API_KEY=... node demo-pack/nim-endpoint.mjs --tool-test --model <exact-model-id>
```

The helper is stdlib-only, reads the key from the environment
only, and never prints it. Then run demo task T1 with real tools
before pooling that model with other participants' runs. If you
cannot run the same NIM model for treatment, a NIM run is your
own exploration, not pooled demo control.
