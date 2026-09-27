"""Offline policy replay or opt-in live Jev evaluation of synthetic/recorded hooks."""

from __future__ import annotations

import argparse
from dataclasses import replace
import json
import os
from pathlib import Path
import statistics
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hooks"))
from jev import Config, decide, jev_request, load_api_key  # noqa: E402


REPLACE = {"routine_noise": 0.99, "needs_exact_text": 0.01, "one_off_value": 0.01,
           "filter_approved": True, "filter_confidence": 0.96}
KEEP = {"routine_noise": 0.01, "needs_exact_text": 0.99, "one_off_value": 0.99,
        "filter_approved": False, "filter_confidence": 0.96}


def generated_cases(per_category: int):
    """Reproducible synthetic cases; mocks test policy, not Jev accuracy."""
    for n in range(per_category):
        progress = "".join(f"Compiling module {i:05d} ... done\n" for i in range(360 + n))
        base = {
            "session_id": f"replay-{n}",
            "turn_id": f"turn-{n}",
            "tool_use_id": f"call-{n}",
            "hook_event_name": "PostToolUse",
            "tool_name": "Bash",
            "tool_input": {"command": "build --verbose"},
            "tool_response": progress,
        }
        variations = [
            ("progress", base, REPLACE, True),
            ("failure", {**base, "tool_use_id": f"fail-{n}", "tool_response": progress + "ERROR: link failed\n"}, REPLACE, False),
            ("secret", {**base, "tool_use_id": f"secret-{n}", "tool_response": progress + "api_key = abc123\n"}, REPLACE, False),
            ("secret_input", {**base, "tool_use_id": f"secret-input-{n}", "tool_input": {"command": "run password=abc123"}}, REPLACE, False),
            ("unique", {**base, "tool_use_id": f"unique-{n}", "tool_response": "".join(f"src/file_{i}.py: distinct finding {i}\n" for i in range(360))}, REPLACE, False),
            ("one_off", {**base, "tool_use_id": f"one-off-{n}", "tool_response": progress + f"receipt id: receipt-{n}\n"}, {**REPLACE, "one_off_value": 0.99}, False),
            ("jev_keep", {**base, "tool_use_id": f"jev-keep-{n}"}, KEEP, False),
            ("mcp_text", {**base, "tool_use_id": f"mcp-{n}", "tool_name": "mcp__demo__logs", "tool_input": {}, "tool_response": {"content": [{"type": "text", "text": progress}]}}, REPLACE, False),
            ("mcp_media", {**base, "tool_use_id": f"media-{n}", "tool_name": "mcp__demo__logs", "tool_input": {}, "tool_response": {"content": [{"type": "text", "text": progress}, {"type": "image", "data": "abc"}]}}, REPLACE, False),
            ("short", {**base, "tool_use_id": f"short-{n}", "tool_response": "ok\n"}, REPLACE, False),
        ]
        for category, event, mock_scores, expected in variations:
            yield {"category": category, "event": event, "mock_scores": mock_scores, "expected_replace": expected}


def load_cases(path: Path):
    with path.open(encoding="utf-8") as file:
        for line_number, line in enumerate(file, 1):
            if not line.strip():
                continue
            item = json.loads(line)
            if not isinstance(item, dict) or not isinstance(item.get("event"), dict):
                raise ValueError(f"invalid case at line {line_number}")
            yield item


def run(cases, *, live: bool, mode: str, config: Config, key: str = "") -> dict:
    if live and not key:
        raise ValueError("--live requires a Jev API key")
    active = replace(config, enabled=True, mode=mode)
    rows = []
    for case in cases:
        if live:
            evaluator = lambda state, settings: jev_request(state, settings, key)
        else:
            mock_scores = case.get("mock_scores")
            evaluator = lambda _state, _settings: mock_scores
        outcome = decide(case["event"], active, evaluator=evaluator, simulate=True)
        predicted = outcome.status == "replace" or (
            mode == "observe"
            and outcome.status == "candidate"
            and outcome.reason == "observe"
            and (case["event"].get("tool_name") == "Bash" or config.allow_mcp_replacement)
        )
        expected = case.get("expected_replace")
        rows.append({
            "category": case.get("category", "unlabelled"),
            "status": outcome.status,
            "reason": outcome.reason,
            "predicted_replace": predicted,
            "expected_replace": expected,
            "false_replace": expected is False and predicted,
            "missed_replace": expected is True and not predicted,
            "original_chars": outcome.original_chars,
            "capsule_chars": outcome.capsule_chars,
            "elapsed_ms": outcome.elapsed_ms,
            "scores": outcome.scores,
        })
    elapsed = sorted(row["elapsed_ms"] for row in rows)
    def percentile(p: float) -> int:
        return elapsed[min(len(elapsed) - 1, round((len(elapsed) - 1) * p))] if elapsed else 0
    by_category = {}
    for category in sorted({row["category"] for row in rows}):
        selected = [row for row in rows if row["category"] == category]
        by_category[category] = {
            "cases": len(selected),
            "predicted_replacements": sum(row["predicted_replace"] for row in selected),
            "false_replacements": sum(row["false_replace"] for row in selected),
            "missed_replacements": sum(row["missed_replace"] for row in selected),
        }
    return {
        "kind": "LIVE JEV EVALUATION" if live else "OFFLINE POLICY REPLAY (mock Jev scores)",
        "mode": mode,
        "cases": len(rows),
        "candidates": sum(row["status"] in ("candidate", "replace") for row in rows),
        "simulated_replacements": sum(row["status"] == "replace" for row in rows),
        "false_replacements": sum(row["false_replace"] for row in rows),
        "missed_replacements": sum(row["missed_replace"] for row in rows),
        "simulated_chars_removed": sum(max(0, row["original_chars"] - row["capsule_chars"]) for row in rows if row["status"] == "replace"),
        "p50_ms": percentile(0.5),
        "p95_ms": percentile(0.95),
        "mean_ms": round(statistics.mean(elapsed), 1) if elapsed else 0,
        "by_category": by_category,
        "rows": rows,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, help="JSONL cases; defaults to generated synthetic cases")
    parser.add_argument("--per-category", type=int, default=100, help="generated cases per category")
    parser.add_argument("--live", action="store_true", help="call TypeSafe; requires an API key and incurs charges")
    parser.add_argument("--live-max-calls", type=int, default=50, help="explicit cap on live Jev requests (default: 50)")
    parser.add_argument("--mode", choices=("observe", "replace"), default="replace")
    parser.add_argument("--details", action="store_true", help="include per-case rows")
    parser.add_argument("--write-corpus", type=Path, help="write generated cases as JSONL for later replay")
    args = parser.parse_args()
    if args.per_category < 1 or args.per_category > 500:
        parser.error("--per-category must be between 1 and 500")
    cases = list(load_cases(args.input) if args.input else generated_cases(args.per_category))
    if args.live and not args.input:
        # The mock-only jev_keep row duplicates progress output and has no live label.
        cases = [case for case in cases if case["category"] != "jev_keep"]
    if args.live and len(cases) > args.live_max_calls:
        parser.error(f"{len(cases)} cases exceed --live-max-calls={args.live_max_calls}; choose a smaller corpus or raise the cap explicitly")
    key = ""
    if args.live:
        data_dir = os.environ.get("CODEX_JEV_DATA_DIRECTORY")
        if not data_dir:
            parser.error("set CODEX_JEV_DATA_DIRECTORY to the installed PLUGIN_DATA path for --live")
        key = load_api_key(Path(data_dir))
    if args.write_corpus:
        if args.input:
            parser.error("--write-corpus only applies to generated cases")
        with args.write_corpus.open("w", encoding="utf-8") as file:
            for item in cases:
                file.write(json.dumps(item, ensure_ascii=False) + "\n")
    report = run(cases, live=args.live, mode=args.mode, config=Config(), key=key)
    if not args.details:
        report.pop("rows")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
