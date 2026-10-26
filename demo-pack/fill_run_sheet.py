#!/usr/bin/env python3
"""Fill a demo-pack run sheet from a harness session export.

Stdlib only. No model calls, no network. It reads the export, it never
rewrites the export.

What it derives from the export (so you do not have to read it):
  - UTC start: time of the earliest event carrying the user prompt
    (agent/inbox/spliced with a user message, else user/message,
    else the earliest event overall).
  - UTC end: time of the last turn/end event, else the latest event
    EXCLUDING command/* events. (The raw latest event is often the
    /export command itself, ~11 minutes after the run in the T1 pilot,
    which overstated the run end. Never use the export command as the
    run end.)
  - Model id: "powered by the <id> model" in the system message,
    else a model id found in request/context events.
  - Whether the export contains usage blocks and tool-call blocks
    (the two things bill-audit needs).

What it CANNOT derive, and leaves for you (pass them as flags, or edit
the written file afterwards):
  - success / criteria check: only you can judge the task outcome.
  - permission mode, output ceiling, commit, pristine check, reset:
    harness settings / git state, not in the export.
  - participant code, task, arm: you tell it.

Usage:
  python3 fill_run_sheet.py --export <unzipped-export-dir | session-export.zip> \\
      --task T1 --out run-sheet.md
  python3 fill_run_sheet.py --export <dir-or-zip> --task T1 --arm control \\
      --participant pilot --permission "Workspace Write" \\
      --output-ceiling default --commit <hash> \\
      --pristine "10 pass / 2 fail" \\
      --reset "yes, git checkout -- . && git clean -fd" \\
      --success pass --criteria "FINDINGS.md lists ..." \\
      --notes "Pilot control run" --out run-sheet.md

The written file follows demo-pack/RUN_SHEET_TEMPLATE.md line for line.
Fields still needing a human are left as their <...> placeholder, and
the script prints them, so you edit a few lines instead of all of them.
Run demo-pack/preflight.mjs on the finished bundle afterwards.
"""

import argparse
import json
import re
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path

MODEL_RE = re.compile(r"powered by the (\S+) model")


def iso_from_ms(ms):
    """Epoch milliseconds -> ISO UTC, whole seconds like the template."""
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime(
        "%Y-%m-%dT%H:%M:%SZ"
    )


def iter_event_lines(root):
    """Yield (path, parsed-json-or-None, raw-text) for text files under root."""
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix.lower() not in {".jsonl", ".json", ".log", ".txt"}:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for line in text.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                yield path, json.loads(line), line
            except json.JSONDecodeError:
                yield path, None, line


def find_model_in_text(text):
    m = MODEL_RE.search(text)
    return m.group(1) if m else None


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--export", required=True,
                    help="unzipped export dir, or the session-export.zip")
    ap.add_argument("--task", required=True, help="e.g. T1")
    ap.add_argument("--arm", default="control")
    ap.add_argument("--participant", default=None)
    ap.add_argument("--permission", default=None)
    ap.add_argument("--output-ceiling", default=None)
    ap.add_argument("--commit", default=None)
    ap.add_argument("--pristine", default=None)
    ap.add_argument("--reset", default=None)
    ap.add_argument("--success", default=None, choices=["pass", "fail"])
    ap.add_argument("--criteria", default=None)
    ap.add_argument("--notes", default=None)
    ap.add_argument("--preflight", default=None,
                    help="filled in from a preflight run, if already done")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    src = Path(args.export)
    tmp = None
    if src.is_file() and src.suffix.lower() == ".zip":
        tmp = tempfile.TemporaryDirectory()
        with zipfile.ZipFile(src) as zf:
            zf.extractall(tmp.name)
        root = Path(tmp.name)
    elif src.is_dir():
        root = src
    else:
        print(f"error: --export must be an export dir or .zip, got {src}",
              file=sys.stderr)
        return 2

    events = []          # (time_ms, type, path, obj, raw)
    files = set()
    model_id = None
    has_usage = False
    has_tool_calls = False
    for path, obj, raw in iter_event_lines(root):
        files.add(str(path.relative_to(root)))
        if "usage" in raw:
            has_usage = True
        if "tool" in raw.lower():
            has_tool_calls = True
        if obj is None or not isinstance(obj, dict):
            if model_id is None:
                model_id = find_model_in_text(raw)
            continue
        t = obj.get("time")
        if isinstance(t, (int, float)):
            events.append((int(t), obj.get("type", ""), path, obj, raw))
        if model_id is None:
            model_id = find_model_in_text(raw)
            if model_id is None:
                data = obj.get("data")
                if isinstance(data, dict):
                    for key in ("model", "modelId", "model_id"):
                        if isinstance(data.get(key), str):
                            model_id = data[key]
                            break

    if not events:
        print("error: no timestamped JSON events found in the export",
              file=sys.stderr)
        return 1

    def is_prompt_event(ev):
        _t, typ, _p, obj, raw = ev
        data = obj.get("data", {}) if isinstance(obj, dict) else {}
        if typ == "agent/inbox/spliced":
            inserted = data.get("inserted", [])
            return any(
                item.get("role") == "user" or
                item.get("source", {}).get("kind") == "user"
                for item in inserted if isinstance(item, dict)
            )
        return typ == "user/message"

    prompt_events = [ev for ev in events if is_prompt_event(ev)]
    start_ev = min(prompt_events or events, key=lambda ev: ev[0])
    turn_ends = [ev for ev in events if ev[1] == "turn/end"]
    non_command = [ev for ev in events
                   if not ev[1].startswith("command/")]
    end_ev = (max(turn_ends, key=lambda ev: ev[0]) if turn_ends
              else max(non_command or events, key=lambda ev: ev[0]))
    start_ms, end_ms = start_ev[0], end_ev[0]

    def field(value, placeholder):
        return value if value is not None else placeholder

    lines = [
        "# Run sheet",
        "",
        f"- Participant code: {field(args.participant, '<code, not your personal name>')}",
        f"- Task: {args.task}",
        f"- Arm: {args.arm}",
        f"- Model id (exact, as reported by the route): {field(model_id, '<e.g. deepseek-flash>')}",
        f"- UTC start (ISO): {iso_from_ms(start_ms)}",
        f"- UTC end (ISO): {iso_from_ms(end_ms)}",
        f"- Permission mode: {field(args.permission, '<as set in the harness>')}",
        f"- Output ceiling: {field(args.output_ceiling, '<default, or the value you set>')}",
        f"- TestingPlatform commit: {field(args.commit, '<git rev-parse HEAD in the checkout>')}",
        f"- Demo-target pristine check before this run: {field(args.pristine, '<10 pass / 2 fail, or what you saw>')}",
        f"- Demo-target reset before this run: {field(args.reset, '<yes, git checkout -- . && git clean -fd>')}",
        f"- Success (pass or fail, against TASKS.md criteria for this task): {field(args.success, '<pass | fail>')}",
        f"- Criteria check (one line: which criteria were met, which were not): {field(args.criteria, '<...>')}",
        f"- Notes (one line): {field(args.notes, '<...>')}",
        "- Bundle files: session-export.zip, run-sheet.md, demo-target-diff.txt",
        f"- Preflight result: {field(args.preflight, '<pass, with warnings listed here if any>')}",
        "",
    ]
    Path(args.out).write_text("\n".join(lines), encoding="utf-8")

    print(f"events: {len(events)} in {len(files)} file(s)")
    print(f"start: {iso_from_ms(start_ms)}  (exact {start_ms} ms, "
          f"{start_ev[1]} seq from {start_ev[2].name})")
    print(f"end:   {iso_from_ms(end_ms)}  (exact {end_ms} ms, {end_ev[1]})")
    print(f"duration: {(end_ms - start_ms) / 1000:.1f}s")
    print(f"model: {model_id or '(not found in export)'}")
    print(f"usage blocks present: {has_usage}")
    print(f"tool-call mentions present: {has_tool_calls}")
    print(f"wrote: {args.out}")
    missing = []
    if args.participant is None:
        missing.append("participant code")
    if model_id is None:
        missing.append("model id")
    for name, val in [("permission mode", args.permission),
                      ("output ceiling", args.output_ceiling),
                      ("commit", args.commit),
                      ("pristine check", args.pristine),
                      ("reset", args.reset),
                      ("success", args.success),
                      ("criteria", args.criteria),
                      ("notes", args.notes),
                      ("preflight", args.preflight)]:
        if val is None:
            missing.append(name)
    if missing:
        print("still needs a human (placeholders left in the file): "
              + ", ".join(missing))
    else:
        print("run sheet fully filled — run preflight on the bundle next.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
