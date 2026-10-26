# Run sheet — copy once per task and fill in EVERY field

Delete the `<...>` placeholders as you fill each line in. A run sheet
with a blank field or a leftover placeholder is incomplete and will be
sent back. Use relative paths only — never write your home directory
path here.

- Participant code: <code, not your personal name>
- Task: <T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8>
- Arm: control
- Model id (exact, as reported by the route): <e.g. deepseek-flash>
- UTC start (ISO): <e.g. 2026-10-27T14:00:00Z>
- UTC end (ISO): <e.g. 2026-10-27T14:12:00Z>
- Permission mode: <as set in the harness>
- Output ceiling: <default, or the value you set>
- TestingPlatform commit: <git rev-parse HEAD in the checkout>
- Demo-target pristine check before this run: <10 pass / 2 fail, or what you saw>
- Demo-target reset before this run: <yes, git checkout -- . && git clean -fd>
- Success (pass or fail, against TASKS.md criteria for this task): <pass | fail>
- Criteria check (one line: which criteria were met, which were not): <...>
- Notes (one line): <...>
- Bundle files: session-export.zip, run-sheet.md, demo-target-diff.txt
- Preflight result: <pass, with warnings listed here if any>
