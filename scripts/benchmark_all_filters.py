#!/usr/bin/env python3
"""Reproducible three-filter policy replay and paired live command-hook benchmark.

The mock run measures policy and model-visible text, not Jev accuracy. The live
run uses a private .env copy and real command output. Neither run
measures Codex billing or end-to-end task completion.
"""

from __future__ import annotations

import argparse
from collections import defaultdict
import json
import os
from pathlib import Path
import random
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
REPO = ROOT
sys.path.insert(0, str(ROOT / "hooks"))
from jev import Config, decide  # noqa: E402
from search_listing import decide_search_listing  # noqa: E402
from test_build import decide_test_build  # noqa: E402
from benchmark_context import token_counter  # noqa: E402
from live_key import copy_key  # noqa: E402

HOOK = ROOT / "hooks" / "post_tool_use.py"
GOOD = {"routine_noise": 0.98, "needs_exact_text": 0.01, "one_off_value": 0.01,
        "filter_approved": True, "filter_confidence": 0.96}
UNCERTAIN = {"routine_noise": 0.59, "needs_exact_text": 0.50, "one_off_value": 0.50,
             "filter_approved": False, "filter_confidence": 0.25}
ONE_OFF = {**GOOD, "one_off_value": 0.99}
ROUTES = {"output": decide, "test_build": decide_test_build, "search_listing": decide_search_listing}


def percentiles(values: list[float]) -> dict:
    ordered = sorted(values)
    if not ordered:
        return {"p50": 0, "p95": 0, "max": 0}
    return {"p50": round(ordered[round((len(ordered) - 1) * .50)], 1),
            "p95": round(ordered[round((len(ordered) - 1) * .95)], 1),
            "max": round(ordered[-1], 1)}


def event(command: str, output: str, call: str, transcript: Path | None = None) -> dict:
    item = {"hook_event_name": "PostToolUse", "tool_name": "Bash",
            "session_id": "benchmark", "turn_id": "benchmark", "tool_use_id": call,
            "tool_input": {"command": command}, "tool_response": output}
    if transcript:
        item["transcript_path"] = str(transcript)
    return item


def progress(count: int) -> str:
    return "".join(f"Compiling module {index:05d} ... done\n" for index in range(count))


def test_log(count: int, failed: bool = False) -> str:
    passes = "".join(f"test_case_{i:04d} (suite.Tests.test_case_{i:04d}) ... ok\n" for i in range(count))
    error = ("test_critical ... FAIL\nTraceback (most recent call last):\n"
             "AssertionError: expected 2, got 3\n") if failed else ""
    return passes + error + f"Ran {count + int(failed)} tests in 1.23s\n" + (
        "FAILED (failures=1)\nProcess exited with code 1\n" if failed else "OK\n")


def search_hits(count: int) -> str:
    return "".join(f"{folder}/module_{i:04d}.py:{i + 1}:def found(): return {i}\n"
                   for folder in ("src/auth", "docs/archive") for i in range(count))


def listing(count: int) -> str:
    return "".join(f"{folder}/module_{i:04d}.py\n"
                   for folder in ("src/auth", "docs/archive") for i in range(count))


def case(route: str, category: str, command: str, output: str,
         expected: str, *, mock: str = "approve", required: tuple[str, ...] = (),
         task: bool = False) -> dict:
    return dict(route=route, category=category, command=command, output=output,
                expected=expected, mock=mock, required=required, task=task)


def mock_cases(per_variant: int):
    """Balanced, varied fixtures; synthetic labels are policy assertions only."""
    for n in range(per_variant):
        long = progress(360 + n % 120)
        tests = test_log(90 + n % 40)
        matches = search_hits(95 + n % 25)
        files = listing(120 + n % 25)
        for item in (
            case("output", "progress", "echo progress", long, "replace"),
            case("output", "diagnostic", "echo progress", long + "ERROR: link failed\n", "skip"),
            case("output", "secret", "echo progress", long + "api_key = fixture-only\n", "skip"),
            case("output", "distinct", "echo progress", "".join(
                f"src/module_{i:04d}.py: distinct finding {i}\n" for i in range(360)), "skip"),
            case("output", "one_off", "echo progress", long + "receipt id: fixture-only\n", "keep", mock="one_off"),
            case("output", "uncertain", "echo progress", long, "keep", mock="uncertain"),
            case("output", "short", "echo progress", "ok\n", "skip"),
            case("test_build", "passing_tests", "python3 -m unittest discover -v", tests, "replace", required=("Ran ", "OK")),
            case("test_build", "failing_tests", "python3 -m unittest discover -v", test_log(90 + n % 40, True),
                 "replace", required=("AssertionError: expected 2, got 3", "FAILED (failures=1)", "Process exited with code 1")),
            case("test_build", "build", "cargo build", "".join(
                f"Compiling unit_{i:04d} v0.1.0\n" for i in range(150 + n % 40)) + "Finished dev profile in 2.34s\n",
                 "replace", required=("Finished dev profile",)),
            case("test_build", "missing_summary", "python3 -m unittest discover -v", tests.replace("Ran ", "Completed ").replace("OK\n", "Done\n"), "skip"),
            case("test_build", "secret", "python3 -m unittest discover -v", tests + "api_key = fixture-only\n", "skip"),
            case("test_build", "uncertain", "python3 -m unittest discover -v", tests, "keep", mock="uncertain"),
            case("test_build", "short", "python3 -m unittest discover -v", "OK\n", "skip"),
            case("search_listing", "search_drop", "rg -n found .", matches, "replace", required=("src/auth/",)),
            case("search_listing", "listing_drop", "rg --files", files, "replace", task=True, required=("src/auth/",)),
            case("search_listing", "listing_summarize", "rg --files", files, "replace", task=True,
                 mock="summarize", required=("src/auth/", "docs/archive:")),
            case("search_listing", "all_retain", "rg -n found .", matches, "keep", mock="retain"),
            case("search_listing", "malformed", "rg -n found .", matches + "not a search hit\n", "skip"),
            case("search_listing", "secret", "rg -n found .", matches + "api_key = fixture-only\n", "skip"),
            case("search_listing", "missing_task", "rg --files", files, "skip"),
        ):
            yield item
    yield case("output", "oversize", "echo progress", progress(65_000), "skip")
    yield case("test_build", "oversize", "python3 -m unittest discover -v", test_log(45_000), "skip")
    yield case("search_listing", "oversize", "rg -n found .", search_hits(25_000), "skip")
    yield case("search_listing", "too_many_groups", "rg -n found .", "".join(
        f"root_{group:02d}/module_{i:03d}.py:{i + 1}:def found(): pass\n"
        for group in range(13) for i in range(50)), "skip")


def mock_choice(state: dict, mode: str) -> dict:
    answers = {}
    for index, group in enumerate(state["groups"]):
        choice = ("retain" if mode == "retain" or "archive" not in group["path"] else
                  "summarize" if mode == "summarize" else "drop")
        answers[f"group_{index}"] = {
            "type": "choice", "choice": choice, "confidence": .97,
            "probabilities": {key: .96 if key == choice else .02
                              for key in ("retain", "summarize", "drop")},
        }
    return answers


def summarize(rows: list[dict], tokenizer: str) -> dict:
    by_route = {}
    for route in sorted({row["route"] for row in rows}):
        subset = [row for row in rows if row["route"] == route]
        before = sum(row["original_tokens"] for row in subset)
        after = sum(row["visible_tokens"] for row in subset)
        selected = [row for row in subset if row["status"] == "replace"]
        selected_before = sum(row["original_tokens"] for row in selected)
        selected_after = sum(row["visible_tokens"] for row in selected)
        by_route[route] = {
            "cases": len(subset), "jev_calls": sum(row["jev_calls"] for row in subset),
            "replaced": len(selected), "kept": sum(row["status"] == "keep" for row in subset),
            "skipped": sum(row["status"] == "skip" for row in subset),
            "original_tokens": before, "visible_tokens": after,
            "tokens_saved": before - after,
            "all_result_reduction_percent": round(100 * (1 - after / before), 1) if before else 0,
            "within_limit_reduction_percent": reduction_percent(
                [row for row in subset if row["category"] != "oversize"]),
            "replaced_result_reduction_percent": round(100 * (1 - selected_after / selected_before), 1) if selected_before else 0,
            "local_latency_ms": percentiles([row["wall_ms"] for row in subset]),
        }
    total_before = sum(row["original_tokens"] for row in rows)
    total_after = sum(row["visible_tokens"] for row in rows)
    return {"tokenizer": tokenizer, "cases": len(rows), "jev_calls": sum(row["jev_calls"] for row in rows),
            "original_tokens": total_before, "visible_tokens": total_after,
            "tokens_saved": total_before - total_after,
            "all_result_reduction_percent": round(100 * (1 - total_after / total_before), 1) if total_before else 0,
            "within_limit_reduction_percent": reduction_percent(
                [row for row in rows if row["category"] != "oversize"]),
            "by_route": by_route}


def reduction_percent(rows: list[dict]) -> float:
    before = sum(row["original_tokens"] for row in rows)
    after = sum(row["visible_tokens"] for row in rows)
    return round(100 * (1 - after / before), 1) if before else 0


def run_mock(per_variant: int = 100) -> dict:
    tokenizer, tokens = token_counter()
    settings = Config(enabled=True, test_build_enabled=True, search_listing_enabled=True)
    rows = []
    with tempfile.TemporaryDirectory(prefix="jev-benchmark-mock-", dir="/tmp") as directory:
        transcript = Path(directory) / "thread.jsonl"
        transcript.write_text(json.dumps({"type": "response_item", "payload": {"role": "user", "content": [
            {"type": "input_text", "text": "Find current authentication code. Archived documentation is irrelevant."}]}}) + "\n")
        for index, item in enumerate(mock_cases(per_variant)):
            call = []
            payload = event(item["command"], item["output"], f"mock-{index}",
                            transcript if item["task"] else None)
            def evaluate(state, *args):
                call.append((state, args))
                return mock_choice(state, item["mock"]) if item["route"] == "search_listing" else (
                    UNCERTAIN if item["mock"] == "uncertain" else ONE_OFF if item["mock"] == "one_off" else GOOD)
            started = time.perf_counter()
            result = ROUTES[item["route"]](payload, settings, evaluator=evaluate, simulate=True)
            wall_ms = (time.perf_counter() - started) * 1000
            visible = result.hook_output["reason"] if result.hook_output else item["output"]
            if result.status != item["expected"]:
                raise AssertionError(f"{item['route']}/{item['category']}: {result.status}/{result.reason}, expected {item['expected']}")
            if len(call) != (0 if item["expected"] == "skip" else 1):
                raise AssertionError(f"unexpected Jev calls for {item['route']}/{item['category']}")
            if any(text not in visible for text in item["required"]):
                raise AssertionError(f"lost required evidence in {item['route']}/{item['category']}")
            if result.status == "replace" and (len(visible) >= len(item["output"]) or "Full original:" not in visible and "full original:" not in visible):
                raise AssertionError(f"invalid replacement for {item['route']}/{item['category']}")
            if call:
                state, args = call[0]
                maximum = 10_000 if item["route"] == "search_listing" else 20_000
                if len(json.dumps(state)) > maximum:
                    raise AssertionError(f"Jev state too large for {item['route']}/{item['category']}")
            rows.append({"route": item["route"], "category": item["category"],
                         "status": result.status, "jev_calls": len(call), "wall_ms": wall_ms,
                         "original_tokens": tokens(item["output"]), "visible_tokens": tokens(visible)})
    report = summarize(rows, tokenizer)
    report.update({"kind": "MOCKED THREE-FILTER POLICY BENCHMARK", "per_variant": per_variant,
                   "synthetic_label_mismatches": 0,
                   "categories": {f"{route}/{category}": len([row for row in rows if row["route"] == route and row["category"] == category])
                                  for route, category in sorted({(row["route"], row["category"]) for row in rows})}})
    return report


def run_command(command: list[str], cwd: Path) -> tuple[str, int]:
    completed = subprocess.run(command, cwd=cwd, capture_output=True, text=True, timeout=90, check=False)
    return completed.stdout + completed.stderr, completed.returncode


def live_cases(root: Path) -> list[dict]:
    """Capture command output once; repeat the same evidence to sample Jev variance."""
    cases = []
    for count in (400, 600, 900):
        script = f'for n in range({count}): print(f"Compiling module {{n:05d}} ... done")'
        command = [sys.executable, "-c", script]
        output, code = run_command(command, REPO)
        assert code == 0
        cases.append(case("output", f"real_progress_{count}", shlex.join(command), output, "any"))

    command = [sys.executable, "-m", "unittest", "discover", "-s", str(ROOT / "tests"),
               "-p", "test_jev.py", "-v"]
    output, code = run_command(command, REPO)
    assert code == 0 and "Ran " in output
    cases.append(case("test_build", "real_python_suite", shlex.join(command), output, "any", required=("Ran ", "OK")))

    failure_dir = root / "failing-suite"
    failure_dir.mkdir()
    (failure_dir / "test_cases.py").write_text("import unittest\nclass Cases(unittest.TestCase):\n" + "".join(
        f"    def test_case_{i:03d}(self): self.assertEqual(1, 1)\n" for i in range(80)) +
        "    def test_case_999(self): self.assertEqual(1, 2)\n")
    command = [sys.executable, "-m", "unittest", "discover", "-s", str(failure_dir), "-v"]
    output, code = run_command(command, root)
    assert code != 0 and "AssertionError: 1 != 2" in output
    cases.append(case("test_build", "real_failing_suite", shlex.join(command), output + f"Process exited with code {code}\n",
                      "any", required=("AssertionError: 1 != 2", "FAILED (failures=1)", "Process exited with code 1")))

    node_dir = root / "node-suite"
    node_dir.mkdir()
    node_file = node_dir / "cases.test.cjs"
    node_file.write_text("const { test } = require('node:test');\n" + "".join(
        f"test('case {i:03d} passes', () => {{}});\n" for i in range(150)))
    command = ["node", "--test", str(node_file)]
    output, code = run_command(command, node_dir)
    assert code == 0 and "pass 150" in output
    cases.append(case("test_build", "real_node_suite", shlex.join(command), output, "any", required=("pass 150", "fail 0")))

    build_dir = root / "c-build"
    (build_dir / "src").mkdir(parents=True)
    for i in range(90):
        (build_dir / "src" / f"unit_{i:03d}.c").write_text(f"int unit_{i:03d}(void) {{ return {i}; }}\n")
    (build_dir / "Makefile").write_text(
        "SOURCES := $(wildcard src/*.c)\nOBJECTS := $(patsubst src/%.c,obj/%.o,$(SOURCES))\n"
        "build: $(OBJECTS)\n\t@echo BUILD SUCCESSFUL\n"
        "obj/%.o: src/%.c\n\t@mkdir -p obj\n\t@echo Compiling $<\n\t@cc -c $< -o $@\n")
    output, code = run_command(["make", "build"], build_dir)
    assert code == 0 and "BUILD SUCCESSFUL" in output
    cases.append(case("test_build", "real_c_build", "make build", output, "any", required=("BUILD SUCCESSFUL",)))

    corpus = root / "corpus"
    auth, archive = corpus / "src/auth", corpus / "docs/archive/2018-marketing"
    auth.mkdir(parents=True)
    archive.mkdir(parents=True)
    for i in range(130):
        (auth / f"token_validation_{i:03d}.py").write_text(f"def found_{i:03d}(): return {i}\n")
    for i in range(220):
        (archive / f"campaign_{i:03d}.md").write_text(f"found archived campaign {i}\n")
    output, code = run_command(["rg", "--files"], corpus)
    assert code == 0 and len(output.splitlines()) == 350
    cases.append(case("search_listing", "real_file_listing", "rg --files", output, "any", task=True,
                      required=("src/auth/",) if len(output) > 4096 else ()))
    output, code = run_command(["rg", "-n", "found"], corpus)
    assert code == 0 and len(output.splitlines()) == 350
    cases.append(case("search_listing", "real_search_hits", "rg -n found .", output, "any", required=("src/auth/",)))
    output, code = run_command(["rg", "-n", "return ", "hooks", "vscode-control"], REPO)
    assert code == 0 and len(output) > 4096
    cases.append(case("search_listing", "real_repository_search",
                      "rg -n 'return ' hooks vscode-control", output, "any"))
    return cases


def invoke_hook(hook: Path, data: Path, item: dict, enabled: bool) -> tuple[dict, list[dict], float]:
    (data / "config.json").write_text(json.dumps({
        "enabled": enabled, "test_build_enabled": enabled,
        "search_listing_enabled": enabled, "mode": "replace", "timeout_seconds": 4.0,
    }))
    log = data / "events.jsonl"
    offset = log.stat().st_size if log.exists() else 0
    started = time.perf_counter()
    completed = subprocess.run([sys.executable, str(hook)], input=json.dumps(item), text=True,
                               capture_output=True, timeout=70, check=True,
                               env={**os.environ, "PLUGIN_DATA": str(data)})
    wall_ms = (time.perf_counter() - started) * 1000
    if completed.stderr:
        raise AssertionError("hook wrote to stderr")
    response = json.loads(completed.stdout)
    records = [json.loads(line) for line in log.read_bytes()[offset:].decode().splitlines()] if log.exists() else []
    if not enabled and (response or records):
        raise AssertionError("disabled hook changed output or wrote a decision")
    return response, records, wall_ms


def run_live(rounds: int = 3, hook: Path = HOOK) -> dict:
    tokenizer, tokens = token_counter()
    rows = []
    with tempfile.TemporaryDirectory(prefix="jev-benchmark-live-", dir="/tmp") as directory:
        root = Path(directory)
        data = root / "plugin-data"
        data.mkdir(mode=0o700)
        copy_key(data)
        transcript = root / "thread.jsonl"
        transcript.write_text(json.dumps({"type": "response_item", "payload": {"role": "user", "content": [
            {"type": "input_text", "text": "Locate current authentication token validation code; archived marketing documents are unrelated."}]}}) + "\n")
        captured = live_cases(root)
        selected = [(round_number, source) for round_number in range(rounds) for source in captured]
        random.Random(260926).shuffle(selected)
        for index, (round_number, source) in enumerate(selected):
            item = event(source["command"], source["output"], f"live-{index}", transcript if source["task"] else None)
            _, _, off_ms = invoke_hook(hook, data, item, False)
            response, records, wall_ms = invoke_hook(hook, data, item, True)
            if not records or records[-1]["filter"] != source["route"]:
                raise AssertionError(f"wrong route for {source['category']}: {records}")
            if any(row["status"] != "calling" or row["filter"] != source["route"]
                   for row in records[:-1]):
                raise AssertionError(f"unexpected Jev request records: {records}")
            status = records[-1]["status"]
            if status == "replace" and response.get("continue") is not False or status != "replace" and response:
                raise AssertionError(f"invalid hook response for {source['category']}: {status}")
            visible = response["reason"] if response else source["output"]
            for fragment in source["required"]:
                if fragment not in visible:
                    raise AssertionError(f"lost {fragment!r} in {source['category']}")
            if status == "replace":
                match = re.search(r"full original: ([^\]\r\n]+\.txt)", visible, re.I)
                if not match:
                    raise AssertionError("replacement missing original path")
                original = Path(match.group(1))
                if (not original.is_relative_to(data) or original.is_symlink()
                        or original.read_text() != source["output"]
                        or stat.S_IMODE(original.stat().st_mode) != 0o600):
                    raise AssertionError("saved original differs or is not private")
            rows.append({"route": source["route"], "category": source["category"],
                         "status": status, "jev_calls": sum(row["status"] == "calling" for row in records),
                         "wall_ms": wall_ms, "off_ms": off_ms,
                         "original_tokens": tokens(source["output"]), "visible_tokens": tokens(visible),
                         "original_chars": len(source["output"]), "visible_chars": len(visible)})

        edges = [case("output", "oversize", "echo progress", progress(65_000), "skip"),
                 case("test_build", "oversize", "python3 -m unittest discover -v", test_log(45_000), "skip"),
                 case("search_listing", "oversize", "rg -n found .", search_hits(25_000), "skip"),
                 case("output", "secret", "echo progress", progress(400) + "api_key = fixture-only\n", "skip"),
                 case("test_build", "secret", "python3 -m unittest discover -v", test_log(100) + "api_key = fixture-only\n", "skip"),
                 case("search_listing", "malformed", "rg -n found .", search_hits(100) + "not a search hit\n", "skip")]
        for index, source in enumerate(edges):
            item = event(source["command"], source["output"], f"edge-{index}")
            response, records, wall_ms = invoke_hook(hook, data, item, True)
            if response or len(records) != 1 or records[0]["status"] != "skip" or records[0]["filter"] != source["route"]:
                raise AssertionError(f"unsafe edge result: {source['route']}/{source['category']}: {records}")
            rows.append({"route": source["route"], "category": source["category"],
                         "status": "skip", "jev_calls": 0, "wall_ms": wall_ms,
                         "off_ms": None, "original_tokens": tokens(source["output"]),
                         "visible_tokens": tokens(source["output"]),
                         "original_chars": len(source["output"]), "visible_chars": len(source["output"])})
    report = summarize(rows, tokenizer)
    paired = [row for row in rows if row["off_ms"] is not None]
    report.update({"kind": "LIVE JEV THREE-FILTER COMMAND-HOOK BENCHMARK", "rounds": rounds,
                   "real_command_fixtures": len(captured), "paired_off_latency_ms": percentiles([row["off_ms"] for row in paired]),
                   "paired_enabled_latency_ms": percentiles([row["wall_ms"] for row in paired]),
                   "added_wall_latency_ms": percentiles([row["wall_ms"] - row["off_ms"] for row in paired]),
                   "by_fixture": {category: {
                       "runs": len(group), "replaced": sum(row["status"] == "replace" for row in group),
                       "kept": sum(row["status"] == "keep" for row in group),
                       "skipped": sum(row["status"] == "skip" for row in group),
                       "jev_calls": sum(row["jev_calls"] for row in group),
                       "mean_token_reduction_percent": round(100 * (1 - sum(row["visible_tokens"] for row in group) /
                           sum(row["original_tokens"] for row in group)), 1),
                   } for category in sorted({row["category"] for row in rows})
                       if (group := [row for row in rows if row["category"] == category])}})
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("mock", "live"), default="mock")
    parser.add_argument("--per-variant", type=int, default=100)
    parser.add_argument("--rounds", type=int, default=3)
    parser.add_argument("--hook-script", type=Path, default=HOOK)
    args = parser.parse_args()
    if not 1 <= args.per_variant <= 300 or not 1 <= args.rounds <= 5:
        parser.error("--per-variant must be 1..300 and --rounds must be 1..5")
    report = (run_mock(args.per_variant) if args.mode == "mock" else
              run_live(args.rounds, args.hook_script.resolve(strict=True)))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
