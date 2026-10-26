# demo-target

A small, standalone, dependency-free Node.js project. It exists for one
purpose: to be the fixed workspace for the WING predictive-tooling demo,
where the same task is run once with predictive tooling OFF (control)
and once with it ON (treatment), and the two runs are compared with the
bill-audit reporter in `deepseek-harness/scripts/bill-audit/`.

It is not a product, and it is not meant to be improved for its own
sake. Every quirk below is deliberate, and each one is a demo task.

## Run

```sh
npm test
```

`npm test` runs `node --test --test-concurrency=1 test/*.test.js`.
The concurrency limit is load-bearing, not cosmetic: it makes
test-file order deterministic (alphabetical), which is what makes the
T7 full-suite-only failure reproducible instead of racy. (A bare
`node --test test/` directory argument does not run the suite on
Node 24 — use the glob form above.)

The CLI:

```sh
node src/cli.js greet Ada        # prints: User: Ada
node src/cli.js --help
```

The CLI greet command uses `formatUser()` from `src/util.js`.

## Files

- `src/parse.js` — parses `HDR:<number>\n<body>` text.
- `src/util.js` — helpers, including `sumRange()` and `formatUser()`.
- `src/cli.js` — the tiny CLI (greet + help).
- `src/retry.js` — a retry helper.
- `src/fetch.js` — a fetch helper with retry.
- `src/registry.js` — a tiny event registry backed by a file on disk.
- `test/*.test.js` — `node:test` suite, no dependencies.

## Pristine state (read this before judging a run)

A fresh checkout has exactly two failing tests in the full suite, and
that is by design — they are two different demo tasks:

1. `test/util.test.js` — `sumRange` stops one short of `end`, so
   `sumRange(1, 3)` returns 3 instead of 6. This is task T2 (fix the
   failing test without changing any test file).
2. `test/registry-b.test.js` — the registry test assumes a fresh
   registry, but `test/registry-a.test.js` has already written state
   to the on-disk file `src/registry.js` uses. This test passes on
   its own (after a reset) and fails only in the full suite. This is
   task T7 (diagnose the suite-only failure, fix it, write FIX.md).

Consequence, stated plainly so nobody is misled: task T2's
"suite green" criterion and task T7's fix overlap. An agent that fixes
only `sumRange` still leaves the registry failure in the full suite;
an agent that makes the suite green has fixed both. Judge T2 on
whether the `sumRange` test passes and no test file changed, and judge
T7 on whether FIX.md identifies the shared on-disk registry state as
the root cause — not on the bare green/red of the suite alone.

Everything else in the pristine suite passes. The following behaviours
are also deliberately absent, each as its own task:

- No `--json` flag on the CLI, and help does not mention one (T3).
- No name validation: empty names and names over 100 characters are
  formatted as-is (T4).
- The retry loop in `src/retry.js` and the retry loop in
  `src/fetch.js` are duplicates; there is no shared helper yet (T5).
- Parser error paths (empty input, malformed header, truncated body)
  are implemented in `src/parse.js` but have no tests yet (T6).
- `FINDINGS.md` does not exist yet (T1: write it).
- `FIX.md` does not exist yet (T7: write it).
- `formatUser` is the name used everywhere, including this README
  (T8: rename it everywhere, including docs and tests, with zero
  references to the old name remaining; the new name is given in the
  task prompt, and deliberately appears nowhere in this pristine
  codebase).

## Reset rule (before EVERY run)

```sh
git checkout -- . && git clean -fd
```

Or re-copy the pristine folder. Never let one run's edits — or the
`.demo-registry.json` state file a run leaves behind — leak into the
next run. That state file is intentionally not gitignored, so
`git clean -fd` removes it; if it were ignored, the reset would
silently stop working and the T7 failure would leak across runs.
