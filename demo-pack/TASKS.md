# Demo task list — control vs treatment

Purpose: produce investor-grade evidence that predictive tooling saves real
agent cost. Each task is run TWICE with the same prompt, the same workspace
snapshot, the same model, and the same session settings: once with predictive
tooling OFF (control), once with it ON (treatment). The reporter (`bill-audit.mjs`)
turns each run's session export into requests / tool calls / cost, and the
compare step turns the pairs into savings.

## The one honest fork in this document

**Treatment is not built yet.** "Predictive tooling ON" means the harness
running a prefetch plugin: the K3 pattern predictor as a `tools/pre-execute`
plugin that prefetches the top-3 predicted next READ-ONLY calls in parallel,
with a freshness recheck before any prefetched result is used, and
predicted-but-unmade calls never served. That plugin is the next build (see
README § "Next build"). Until it lands:

- Run the CONTROL arm now. It gives you the baseline, the methodology, and
  the evidence pipeline, all real.
- Do NOT present control-only numbers as savings. Savings exist only when a
  treatment run beats its control twin on the same task.

## Demo target (fixed snapshot, reset before every run)

A small standalone project, `demo-target/`, checked into its own repo or folder
with git, so every run starts from the same commit:

- `src/parse.js` — a small input parser (with error paths: empty input,
  malformed header, truncated body).
- `src/util.js` — helpers including a planted off-by-one in `sumRange`
  (and one failing test that exposes it).
- `src/cli.js` — a tiny CLI without a `--json` flag yet.
- `src/retry.js` + `src/fetch.js` — duplicated retry logic (refactor target).
- `test/*.test.js` — node:test suite, no dependencies.
- One test that fails only when the full suite runs (shared-state leak
  between two test files — the diagnose target).

Reset rule before EVERY run: `git checkout -- . && git clean -fd` in
`demo-target/` (or re-copy the pristine folder). Never let a control run's
edits leak into a treatment run.

## Fixed model and settings (record these per run)

- Model: ONE model for both arms. Recommended default: `deepseek-flash`
  (current official model; priced in prices.json). If you use a Kimi model,
  use the same one both arms.
- Permission mode, output ceiling, and workspace: identical both arms.
- Record in each run's `success.md`: model id, run timestamp (UTC), arm,
  permission mode, and whether the run succeeded.

## Pristine demo-target note (read before judging any run)

A fresh `demo-target/` has exactly two failing tests, and they belong
to two different tasks (see `demo-target/README.md` for the full
account):

- `sumRange` in `test/util.test.js` fails on its own (off-by-one) —
  task T2's failure.
- `registry-b` in `test/registry-b.test.js` fails only in the full
  suite (on-disk registry state written by `registry-a`) — task T7's
  failure. Every other pristine test passes.

Therefore, where a task below says "suite green", read it as: the
task's own tests pass and no previously-passing test breaks. The two
pristine failures do not count against a task unless that task is the
one that owns that failure. Full-suite green is the combined T2+T7
outcome, not the bar for T1, T3, T4, T5, T6, or T8 on their own.

## Tasks (prompt text is fixed — paste verbatim)

### T1 — Explore and report (read-heavy)
Prompt: "List every module in this project that touches user input, and for
each, state in one sentence what validation it performs. Write the answer
to FINDINGS.md. Do not change any source file."
Success: FINDINGS.md names every input-touching module with a correct
validation statement; no source file changed.

### T2 — Fix the failing test (diagnose + fix)
Prompt: "The test suite has one failing test. Find the bug, fix it, and make
the suite green without changing any test file."
Success: the `sumRange` test passes; only source files changed.
(See the Pristine note: full-suite green additionally requires the
T7 registry fix, and is not the T2 bar on its own.)

### T3 — Add a CLI flag (feature)
Prompt: "Add a --json flag to the CLI that prints the result as JSON.
Update the help text. Do not change existing behavior."
Success: `--json` outputs valid JSON; help mentions it; existing flags
behave as before.

### T4 — Add validation (feature + tests)
Prompt: "Reject empty names and names over 100 characters with clear error
messages. Add tests for both cases."
Success: both cases error with clear messages; new tests pass; suite green.

### T5 — Refactor duplicated logic (multi-file edit)
Prompt: "Extract the duplicated retry logic in retry.js and fetch.js into a
shared helper both modules use. No behavior change; the suite must stay green."
Success: one shared helper exists and both modules call it; suite green.

### T6 — Cover error paths (test writing)
Prompt: "Write tests covering the parser's error paths: empty input,
malformed header, and truncated body. All new tests must pass."
Success: new test file exists covering all three paths; suite green.

### T7 — Diagnose suite-only failure (debugging)
Prompt: "The suite fails when run in full but passes file by file. Diagnose
why, fix it, and write a one-paragraph root-cause note to FIX.md."
Success: the `registry-b` test passes in the full suite; FIX.md states
the true root cause (shared on-disk registry state). (See the Pristine
note: full-suite green additionally requires the T2 `sumRange` fix,
and is not the T7 bar on its own.)

### T8 — Rename across the codebase (multi-file sweep)
Prompt: "Rename `formatUser` to `formatAccount` everywhere, including docs
and tests. Nothing may reference the old name afterwards."
Success: zero references to `formatUser` remain; suite green.

## Evidence layout (per task, per arm)

```
evidence/
  T1/control/session-export/  meter.json  report.md  success.md
  T1/treatment/session-export/ meter.json  report.md  success.md
  T1/comparison.md / comparison.json     # from: bill-audit.mjs compare --control evidence/T1/control/meter.json --treatment evidence/T1/treatment/meter.json --out evidence/T1
  T2/control/ ...  (same shape)
  ...
```

(Per-task folders = Layout B in the README. For the all-tasks total, sum
the per-task comparisons; the pairs are the evidence, the sum is arithmetic.)

`success.md` is filled by YOU after each run (the reporter cannot judge
success): task id, arm, model, UTC timestamp, pass/fail against the success
criteria above, and one line of notes. A cheaper FAILED run is not a win —
the comparison table shows success next to cost for exactly this reason.

## How to read the result for investors

Lead with two numbers: savings percentage across tasks, and success parity
(treatment succeeded on at least as many tasks as control). Absolute dollars
are equivalent official-list-price costs, not amounts billed: free routes
may bill $0, so the dollar figure answers "what this workload costs at list
prices", and the percentage is what transfers to a paying deployment. Both
arms use the same model and the same price table, so the percentage is
robust to the price table itself.
