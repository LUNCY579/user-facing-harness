# Bill-audit meter (demo copy)

Stdlib-only Node reporter. It makes no model calls: it replays a
session export and counts agent requests, tokens, tool-call
trajectory, and cost at official list prices.

## Files

- `bill-audit.mjs` — the reporter. It reads `prices.json` from the
  same directory as the script, so keep the two files together.
- `prices.json` — price table, version 2026-10-26. DeepSeek rows
  were verified on DeepSeek's official pricing page on 2026-10-26.
  Kimi rows are secondary-cross-checked, not official-verified:
  re-verify Kimi on Moonshot's official pricing page before any
  investor use.

## This copy vs the original

This is the demo copy, canonical for this demo. The original lives
in the deepseek-harness repo under `scripts/bill-audit/` and is
left untouched. Do not edit both copies; if a price or a rule
changes, change it here and note the change in the demo record.

## Run (Cheng, on receipt)

```sh
node demo-pack/meter/bill-audit.mjs run \
  --input <unzipped-export-folder> \
  --out evidence/<TASK>/<arm> \
  --arm control|treatment --task <TASK> --success true|false
```

See `../SAVE_AND_COMPARE.md` for the full save/compare workflow.
Cost convention: input tokens x cache-miss rate + cache-read
tokens x cache-hit rate + output tokens x output rate, per 1M
tokens; cache-write is not separately billed. Unknown models land
in an unpriced bucket and are reported, never priced by guess.
Costs are equivalent official-list-price costs, not amounts billed
(free routes may bill $0); the savings percentage is the
transferable claim, and only for priced models.
