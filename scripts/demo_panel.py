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


def choice(name: str, selected: str, **probabilities: float) -> dict:
    return {"name": name, "selected": selected, "probabilities": probabilities}


def checks(routine: float, exact: float, unique: float) -> list[dict]:
    return [
        {"name": "routine_noise", "probability": routine},
        {"name": "needs_exact_text", "probability": exact},
        {"name": "one_off_value", "probability": unique},
    ]


SCENES = (
    ("Output · Choice + Noul", "output", "replace",
     [choice("filter_decision", "filter", filter=.88, keep=.12)], checks(.91, .12, .08), "output_filter"),
    ("Output · Choice only", "output", "keep",
     [choice("filter_decision", "keep", filter=.19, keep=.81)], [], "output_keep"),
    ("Output · Noul only", "output", "keep", [], checks(.28, .84, .76), "output_noul"),
    ("Test/build · Choice + Noul", "test_build", "replace",
     [choice("filter_decision", "filter", filter=.94, keep=.06)], checks(.93, .14, .11), "build_filter"),
    ("Test/build · Choice only", "test_build", "keep",
     [choice("filter_decision", "keep", filter=.23, keep=.77)], [], "build_keep"),
    ("Test/build · Noul only", "test_build", "keep", [], checks(.34, .89, .71), "build_noul"),
    ("Search · retain", "search_listing", "keep",
     [choice("group_0", "retain", retain=.79, summarize=.16, drop=.05)], [], "search_retain"),
    ("Search · summarize", "search_listing", "replace",
     [choice("group_0", "summarize", retain=.13, summarize=.78, drop=.09)], [], "search_summarize"),
    ("Search · drop", "search_listing", "replace",
     [choice("group_0", "drop", retain=.03, summarize=.07, drop=.90)], [], "search_drop"),
)


def snapshot(scene: tuple, history: list[dict], sequence: int) -> bytes:
    _, filter_name, status, choices, signals, theme = scene
    decision_id = uuid.uuid4().hex
    history.append({"id": decision_id, "theme": theme, "elapsed_ms": 18 + (sequence * 17) % 210})
    row = {"version": 1, "id": decision_id, "demo": True,
           "at": datetime.now(timezone.utc).isoformat(),
           "filter": filter_name, "status": status,
           "call_index": 1, "call_count": 1,
           "choices": choices, "checks": signals,
           "recent": history[-5:]}
    history[:] = history[-5:]
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
