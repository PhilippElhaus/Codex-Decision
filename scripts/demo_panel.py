#!/usr/bin/env python3
"""Cycle synthetic Jev decisions through the live VS Code panel, then restore it."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import signal
import stat
import sys
import tempfile
from threading import Event
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hooks"))
from receipts import _locked, _replace_private  # noqa: E402


SCENES = (
    ("Output · omit routine progress", "output", "Compiling demo module 17", "omit", .98, .02),
    ("Output · keep version string", "output", "Version 7.42.19", "keep", .08, .97),
    ("Test/build · omit passing case", "test_build", "PASS demo_test_017", "omit", .99, .01),
    ("Test/build · keep failure", "test_build", "FAIL demo_test_018: expected 2, got 3", "keep", .01, .99),
    ("Search · omit unrelated match", "search_listing", "src/demo.rs:91: unrelated sample", "omit", .97, .02),
    ("Search · keep relevant match", "search_listing", "src/jev.rs:42: line_policy", "keep", .04, .96),
)


def snapshot(scene: tuple, history: list[dict], sequence: int) -> bytes:
    _, filter_name, excerpt, action, can_omit, exact_needed = scene
    decision_id = uuid.uuid4().hex
    line = {"id": f"{decision_id}-{sequence}", "line": sequence,
            "excerpt": f"[DEMO] {excerpt}", "summary": "Synthetic line",
            "action": action, "can_omit": can_omit, "exact_needed": exact_needed}
    history.append(line)
    history[:] = history[-5:]
    row = {"version": 2, "id": decision_id, "demo": True,
           "at": datetime.now(timezone.utc).isoformat(),
           "filter": filter_name, "status": "replace" if action == "omit" else "keep",
           "batch_elapsed_ms": 18 + (sequence * 17) % 210,
           "latest": line, "recent": history,
           "totals": {"seen": 1, "judged": 1, "kept": int(action == "keep"),
                      "omitted": int(action == "omit"), "protected": 0,
                      "unjudged": 0, "requests": 1}}
    return json.dumps(row, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def private_snapshot(path: Path) -> bytes:
    details = path.lstat()
    if not stat.S_ISREG(details.st_mode) or path.is_symlink() or details.st_size > 16_384:
        raise ValueError("Jev decision snapshot must be a small regular file")
    if os.name != "nt" and stat.S_IMODE(details.st_mode) != 0o600:
        raise ValueError("Jev decision snapshot must be owner-only")
    return path.read_bytes()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True,
                        help="Installed Jev PLUGIN_DATA directory")
    parser.add_argument("--cycles", type=int, default=3)
    parser.add_argument("--interval", type=float, default=6.0,
                        help="Seconds per scene (default: 6)")
    args = parser.parse_args()
    if not 1 <= args.cycles <= 20 or not .01 <= args.interval <= 60:
        parser.error("cycles must be 1–20 and interval must be 0.01–60 seconds")
    temp_root = Path(tempfile.gettempdir() if os.name == "nt" else "/tmp").resolve()
    if os.name == "nt" and temp_root.drive.lower() == "d:":
        raise ValueError("Windows temporary files may not be placed on D:")
    storage = args.data_dir.expanduser().resolve(strict=True)
    source = storage / "logs" / "latest-decision.json"

    stop_requested = Event()

    def interrupt(_signum, _frame):
        stop_requested.set()

    signal.signal(signal.SIGINT, interrupt)
    signal.signal(signal.SIGTERM, interrupt)
    with tempfile.TemporaryDirectory(prefix="codex-jev-panel-demo-", dir=temp_root) as temporary:
        backup = Path(temporary) / "original.json"
        with _locked(storage):
            original = private_snapshot(source)
            backup.write_bytes(original)
            backup.chmod(0o600)
        last_demo = original
        history = []
        print(f"Jev panel demo: {len(SCENES)} scenes × {args.cycles} cycles; "
              f"approximately {len(SCENES) * args.cycles * args.interval:.0f} seconds.", flush=True)
        try:
            for cycle in range(args.cycles):
                for index, scene in enumerate(SCENES, start=1):
                    if stop_requested.is_set():
                        break
                    payload = snapshot(scene, history, cycle * len(SCENES) + index)
                    with _locked(storage):
                        if private_snapshot(source) != last_demo:
                            print("A real Jev decision arrived; preserving it and stopping demo.", flush=True)
                            return 0
                        _replace_private(source, payload)
                        last_demo = payload
                    print(f"{cycle + 1}/{args.cycles} · {index}/{len(SCENES)} · {scene[0]}", flush=True)
                    if stop_requested.wait(args.interval):
                        break
                if stop_requested.is_set():
                    print("Demo interrupted.", flush=True)
                    break
        finally:
            with _locked(storage):
                if private_snapshot(source) == last_demo:
                    _replace_private(source, backup.read_bytes())
                    print("Original Jev decision restored.", flush=True)
                else:
                    print("Latest real Jev decision preserved.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
