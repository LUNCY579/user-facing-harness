# Save and compare — Cheng's receipt workflow

This file is for Cheng, not for participants. It is kept in the pack
so the whole demo workflow lives in this one checkout. Participants
send bundles; Cheng saves them, meters them, and pairs them.

## One rule that governs everything

A control run and a treatment run are comparable only as a pair:
same task, same model, same pristine demo-target, same verbatim
prompt, same permission mode, same output ceiling. Success is
reported next to every number. A cheaper failed run is not a win.

Participants run control only. Cheng runs treatment only, on his
laptop, with the predictive prefetch plugin ON. Nobody else needs
the predictor.

## Save: evidence layout

For each received bundle, after preflight passes and the manual
scrub is done, save it under:

```
evidence/<TASK>/control/
  session-export/        # unzipped session export
  meter.json             # bill-audit output
  report.md              # bill-audit report
  run-sheet.md           # participant's run sheet (as received)
  demo-target-diff.txt   # as received
```

For Cheng's own treatment run of the same task and model, save
under `evidence/<TASK>/treatment/` with the same files. Keep
control and treatment for one task and model together; never mix
models inside one comparison.

Unpriced models are compared on tool calls and tokens only, never
converted to dollars without a price. Priced models (see
`meter/prices.json`, table 2026-10-26) may also be compared in
dollars. Report per model; do not pool dollar figures across
models with different prices, and do not pool unpriced models with
priced ones.

## Meter: one run

From this checkout (Node, no install beyond the checkout itself):

```sh
node demo-pack/meter/bill-audit.mjs run \
  --input evidence/<TASK>/control/session-export/ \
  --out evidence/<TASK>/control \
  --arm control --task <TASK> --success true|false
```

`--input` is the unzipped export folder, not the `.zip` file.
`--success` must match the run sheet: `true` for `pass`,
`false` for `fail`. The meter prints one output line:

```
events=... attempts=... retries=... toolCalls=... cost=$...
```

plus any `warning:` lines. Copy that line and its warnings into
the record for the run. The meter counts tokens even for unpriced
models; it never guesses a price. A warning naming an unpriced
model means cost is $0 by exclusion, not by measurement — say so
in any report that cites that run.

## Compare: one pair at a time

```sh
node demo-pack/meter/bill-audit.mjs compare \
  --control evidence/<TASK>/control/meter.json \
  --treatment evidence/<TASK>/treatment/meter.json \
  --out evidence/<TASK>
```

For a whole arm tree at once (Layout A):

```sh
node demo-pack/meter/bill-audit.mjs compare \
  --control-dir evidence/control \
  --treatment-dir evidence/treatment --out evidence
```

Read a comparison as: for this task and model, treatment used X
fewer/more attempts, Y fewer/more tool calls, Z fewer/more tokens
(and dollars, if priced) than control, at success control =
treatment = pass. If either side failed, the pair is not savings
evidence, however cheap it looks.

## Demo table

One row per pair: task, participant code, model, control
attempts / tool calls / tokens (/ dollars if priced) / success,
treatment attempts / tool calls / tokens (/ dollars) / success,
and the delta in each. Label unpriced rows "tokens and tool calls
only". The offline counterfactual trajectory replay (predictor run
over a recorded control trajectory, never trained on it) is a
separate, labeled estimate — never presented as a live result.
The live second run is a new sample, not an identical replay.
