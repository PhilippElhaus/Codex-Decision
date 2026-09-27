"""Measure installed-hook latency and output reduction with synthetic Bash logs.

Runs real Jev requests with a private .env copy. Prints metadata only and
uses a disposable PLUGIN_DATA directory.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import statistics
import subprocess
import tempfile
import time

from replay import generated_cases
from benchmark_context import token_counter
from live_key import copy_key


HOOK = Path(__file__).resolve().parents[1] / "hooks/post_tool_use.py"


def measure(repetitions: int, hook_script: Path = HOOK) -> dict:
    tokenizer, tokens = token_counter()
    rows = []
    cases = [case["event"] for case in generated_cases(repetitions) if case["category"] == "progress"]
    with tempfile.TemporaryDirectory(prefix="codex-jev-measure-", dir="/tmp") as directory:
        data = Path(directory)
        copy_key(data)
        environment = {**os.environ, "PLUGIN_DATA": directory}
        for mode in ("off", "observe", "replace"):
            (data / "config.json").write_text(json.dumps({
                "enabled": mode != "off", "mode": "replace" if mode == "off" else mode,
            }), encoding="utf-8")
            for number, source in enumerate(cases):
                event = {**source, "session_id": f"measure-{mode}", "tool_use_id": f"{mode}-{number}"}
                log = data / "logs/events.jsonl"
                before = log.stat().st_size if log.exists() else 0
                started = time.perf_counter()
                result = subprocess.run(
                    ["python3", str(hook_script)], input=json.dumps(event), text=True,
                    capture_output=True, env=environment, timeout=7, check=True,
                )
                wall_ms = round((time.perf_counter() - started) * 1000)
                if result.stderr:
                    raise RuntimeError("hook wrote to stderr")
                feedback = json.loads(result.stdout)
                appended = log.read_bytes()[before:].decode() if log.exists() else ""
                events = [json.loads(line) for line in appended.splitlines()]
                outcome = events[-1] if events else None
                if mode == "off" and (feedback or events):
                    raise AssertionError("disabled hook should return no feedback or events")
                if mode == "observe" and (feedback or outcome.get("status") not in ("candidate", "keep")):
                    raise AssertionError("observe mode changed output or missed Jev")
                if mode == "replace" and (feedback.get("continue") is not False or outcome.get("status") != "replace"):
                    raise AssertionError(f"replacement failed: {outcome}")
                original_chars = len(event["tool_response"])
                rows.append({
                    "mode": mode, "wall_ms": wall_ms, "status": outcome["status"] if outcome else "off",
                    "hook_ms": outcome["elapsed_ms"] if outcome else 0,
                    "original_chars": original_chars,
                    "visible_chars": outcome["capsule_chars"] if mode == "replace" else original_chars,
                    "original_tokens": tokens(event["tool_response"]),
                    "visible_tokens": tokens(feedback["reason"]) if mode == "replace" else tokens(event["tool_response"]),
                })
    summary = {}
    for mode in ("off", "observe", "replace"):
        sample = [row for row in rows if row["mode"] == mode]
        summary[mode] = {
            "runs": len(sample), "median_wall_ms": round(statistics.median(row["wall_ms"] for row in sample)),
            "p95_wall_ms": sorted(row["wall_ms"] for row in sample)[int(0.95 * (len(sample) - 1))],
            "wall_ms": [row["wall_ms"] for row in sample],
            "statuses": [row["status"] for row in sample],
            "original_chars": sum(row["original_chars"] for row in sample),
            "visible_chars": sum(row["visible_chars"] for row in sample),
            "original_tokens": sum(row["original_tokens"] for row in sample),
            "visible_tokens": sum(row["visible_tokens"] for row in sample),
        }
    summary["replace"]["character_reduction_percent"] = round(
        100 * (1 - summary["replace"]["visible_chars"] / summary["replace"]["original_chars"]), 1,
    )
    summary["replace"]["token_reduction_percent"] = round(
        100 * (1 - summary["replace"]["visible_tokens"] / summary["replace"]["original_tokens"]), 1,
    )
    summary["replace"]["median_added_wall_vs_off_ms"] = (
        summary["replace"]["median_wall_ms"] - summary["off"]["median_wall_ms"]
    )
    saved_tokens = summary["replace"]["original_tokens"] - summary["replace"]["visible_tokens"]
    per_call_saved = saved_tokens / len([row for row in rows if row["mode"] == "replace"])
    summary["replace"]["break_even_input_tokens_per_second"] = round(
        per_call_saved * 1000 / max(1, summary["replace"]["median_added_wall_vs_off_ms"])
    )
    return {"kind": "LIVE HOOK MEASUREMENT", "tokenizer": tokenizer, "summary": summary, "rows": rows}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--hook-script", type=Path, default=HOOK,
                        help="hook adapter to measure, including an installed plugin copy")
    args = parser.parse_args()
    if not 1 <= args.repetitions <= 10:
        parser.error("--repetitions must be 1..10")
    print(json.dumps(measure(args.repetitions, args.hook_script.resolve(strict=True)), indent=2))


if __name__ == "__main__":
    main()
