# Participant checklist — one task at a time

Work through this in order. Do not skip the scrub step.

## Before your first task (once)

- [ ] Clone TestingPlatform, frozen install, setup, `pnpm run dev`
      (see `testing-platform/README.md`) — all from the TestingPlatform
      repo root, NOT from inside `demo-target/`. `pnpm run dev` inside
      `demo-target/` fails with "Missing script: dev", because `dev`
      lives only in the root `package.json` (`demo-target/package.json`
      has only a `test` script). Keep the terminal running;
      open the printed URL including its login token.
- [ ] Prove the model route: Settings → Our Free Model → Free models
      → wait for the roster (or Refresh roster) → Text test on a model
      card. It sends `Reply with exactly: OK`.
- [ ] Write down the EXACT model id the route reports. Use that one
      model for every task. Recommended default: `deepseek-flash`.
- [ ] In `demo-target/`, run `npm test`. Expect **10 pass / 2 fail**
      (the two intended pristine failures). If anything else appears,
      stop and tell Cheng.
- [ ] Reset `demo-target/` (`git checkout -- . && git clean -fd`).
      The pristine check leaves a `.demo-registry.json` state file
      behind; the reset must remove it.

## Before every task

- [ ] Reset `demo-target/` again. Never skip this, even between two
      runs of the same task.
- [ ] Open a harness workspace on `demo-target/` ONLY.
- [ ] Confirm the model, permission mode, and output ceiling are the
      same as your previous tasks. If you changed a setting, write it
      in the run sheet — a run with changed settings is not comparable.

## During the run

- [ ] Paste the prompt verbatim from `TASKS.md`.
- [ ] Do not coach, correct, or re-prompt mid-run.
- [ ] Do not change settings mid-run.
- [ ] If the run stalls or goes off-task, stop it and mark it failed
      in the run sheet. Do not rescue it and report it as a pass.

## After the run

- [ ] Export the session (`/export`) and download the session ZIP.
- [ ] Copy `RUN_SHEET_TEMPLATE.md` to `run-sheet.md` and fill in
      EVERY field. No field left blank, no `<...>` placeholder left.
      Success is `pass` or `fail` against that task's criteria in
      `TASKS.md` — judge it honestly, in one line of notes.
- [ ] In `demo-target/`, write the post-run state to
      `demo-target-diff.txt` (`git diff` plus `git status --short`).
- [ ] Put exactly these three files in a folder named
      `<TASK>-control/`: `session-export.zip`, `run-sheet.md`,
      `demo-target-diff.txt`. Nothing else. No `.env`, no key files,
      no settings dumps, no harness home directory.
- [ ] Run preflight: `node demo-pack/preflight.mjs --bundle <TASK>-control --task <TASK>`.
      Fix every error. Read every warning.
- [ ] Scrub (manual, required — preflight cannot do this part):
      - List the ZIP contents. It must contain only this session and
        only `demo-target/` paths.
      - Search the unzipped export text for API keys, tokens,
        passwords, and your home directory path. If anything secret is
        in there, do NOT send it — delete the export, reset, re-run,
        and check again.
      - Confirm no file outside `demo-target/` is in the bundle.
- [ ] Zip the folder as `<participant-code>-<TASK>-control.zip`
      (a code, not your personal name) and send it to Cheng.

## Never do these

- Point the harness at a personal or work project for a demo run.
- Send API keys, tokens, passwords, or settings files.
- Change the model, permission mode, or task prompt mid-task.
- Edit `TASKS.md`, or edit a test file to make a task pass (except
  where the task itself says to add tests, e.g. T4/T6).
- Report a coached, rescued, or re-prompted run as a clean pass.
