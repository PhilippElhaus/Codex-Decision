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


def row(excerpt: str, action: str, can_omit: float, exact_needed: float,
        reason: str, task_relevant: float | None = None) -> dict:
    return {"excerpt": f"[DEMO] {excerpt}", "action": action,
            "reason": reason, "can_omit": can_omit,
            "exact_needed": exact_needed, "task_relevant": task_relevant}


def output_rows() -> list[dict]:
    rows = [row(f"Compiling demo module {number:02}", "omit", .96 + number % 3 * .01,
                .02, "confident_omission") for number in range(1, 10)]
    rows.insert(4, row("Version 7.42.19 · exact build fingerprint", "keep", .98,
                       .94, "exact_text"))
    rows.append(row("Build finished: 9 modules, 0 errors", "keep", .31,
                    .72, "below_omit_cutoff"))
    return rows


def test_rows() -> list[dict]:
    rows = [row(f"PASS demo_test_{number:03}", "omit", .97 + number % 3 * .01,
                .01, "confident_omission") for number in range(11, 23)]
    rows.insert(6, row("FAIL demo_test_018: expected 2, got 3", "keep", .96,
                       .99, "exact_text"))
    rows.append(row("Tests: 12 passed, 1 failed", "keep", .22, .93,
                    "below_omit_cutoff"))
    return rows


def search_rows() -> list[dict]:
    rows = [row(f"docs/archive/token_{number:03}.rs: token fixture", "omit", .97,
                .01, "confident_omission", .08) for number in range(1, 9)]
    rows.insert(2, row("src/auth/token.rs:42: validate_token()", "keep", .98,
                       .03, "task_relevant", .96))
    rows.insert(6, row("src/auth/token.rs:87: reject_expired()", "keep", .96,
                       .05, "task_relevant", .91))
    return rows


def dense_rows() -> list[dict]:
    rows = []
    for number in range(1, 251):
        if number % 37 == 0:
            rows.append(row(f"Module {number:03}: warning with an exact diagnostic code",
                            "keep", .97, .91, "exact_text"))
        else:
            rows.append(row(f"Module {number:03}: routine progress complete",
                            "omit", .96 + number % 4 * .01, .01,
                            "confident_omission"))
    return rows


SCENES = (
    ("Output · mixed 11-line batch", "output", output_rows),
    ("Test/build · passing lines and one failure", "test_build", test_rows),
    ("Search · relevance protects two matches", "search_listing", search_rows),
    ("Output · full 250-line batch", "output", dense_rows),
    ("Search · fresh batch of individual lines", "search_listing", search_rows),
)


def snapshot(scene: tuple, sequence: int) -> bytes:
    _, filter_name, make_rows = scene
    decision_id = uuid.uuid4().hex
    rows = [{"line": number, **entry} for number, entry in enumerate(make_rows(), start=1)]
    omitted = sum(entry["action"] == "omit" for entry in rows)
    decision = {"version": 3, "id": decision_id, "receipt_id": uuid.uuid4().hex,
                "at": datetime.now(timezone.utc).isoformat(), "filter": filter_name,
                "status": "candidate" if omitted else "keep",
                "batch": {"number": 1, "count": 1, "target_count": len(rows)},
                "rows": rows, "batch_elapsed_ms": 18 + sequence * 17 % 210,
                "totals": {"seen": len(rows), "judged": len(rows),
                           "kept": len(rows) - omitted, "omitted": omitted,
                           "protected": 0, "unjudged": 0, "requests": 1}}
    return json.dumps(decision, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def private_snapshot(path: Path) -> bytes:
    details = path.lstat()
    if not stat.S_ISREG(details.st_mode) or path.is_symlink() or details.st_size > 256 * 1024:
        raise ValueError("Jev decision snapshot must be a bounded regular file")
    if os.name != "nt" and stat.S_IMODE(details.st_mode) != 0o600:
        raise ValueError("Jev decision snapshot must be owner-only")
    return path.read_bytes()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True,
                        help="Installed Jev PLUGIN_DATA directory")
    parser.add_argument("--cycles", type=int, default=3)
    parser.add_argument("--interval", type=float, default=8.0,
                        help="Seconds per scene (default: 8)")
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
        print(f"Jev panel demo: {len(SCENES)} scenes × {args.cycles} cycles; "
              f"approximately {len(SCENES) * args.cycles * args.interval:.0f} seconds.", flush=True)
        try:
            for cycle in range(args.cycles):
                for index, scene in enumerate(SCENES, start=1):
                    if stop_requested.is_set():
                        break
                    payload = snapshot(scene, cycle * len(SCENES) + index)
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
