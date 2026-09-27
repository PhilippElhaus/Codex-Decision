"""Exercise all three filters through the command hook and a process-level Jev mock."""

import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "hooks"))
import jev  # noqa: E402
import search_listing  # noqa: E402
import test_build  # noqa: E402

HOOK = ROOT / "hooks" / "post_tool_use.py"
SCORES = {"routine_noise": 0.98, "needs_exact_text": 0.01, "one_off_value": 0.01,
          "filter_approved": True, "filter_confidence": 0.96}
MOCK_HTTP = '''import io, json, os, urllib.request
def mock_urlopen(request, timeout=None):
    payload = json.loads(request.data)
    with open(os.environ["JEV_MOCK_CALLS"], "a", encoding="utf-8") as log:
        log.write(json.dumps({"state": payload["state"], "questions": list(payload["questions"]),
                              "request_bytes": len(request.data),
                              "auth_ok": request.get_header("Authorization") == "Bearer synthetic-test-key"}) + "\\n")
    if os.environ.get("JEV_MOCK_FAILURE") == "exit":
        raise OSError("Synthetic Jev outage")
    if os.environ.get("JEV_MOCK_FAILURE") == "malformed":
        return io.BytesIO(b"not json")
    answers = {}
    for name, question in payload["questions"].items():
        if question["type"] == "noul":
            answers[name] = {"type": "noul", "noul": 0.98 if name == "routine_noise" else 0.01}
        elif name == "filter_decision":
            answers[name] = {"type": "choice", "choice": "filter", "confidence": 0.96,
                             "probabilities": {"filter": 0.98, "keep": 0.02}}
        else:
            index = int(name.split("_")[1])
            choice = "drop" if "archive" in payload["state"]["groups"][index]["path"] else "retain"
            answers[name] = {"type": "choice", "choice": choice, "confidence": 0.97,
                             "probabilities": {key: 0.96 if key == choice else 0.02
                                               for key in ("retain", "summarize", "drop")}}
    return io.BytesIO(json.dumps({"answers": answers}).encode())
urllib.request.urlopen = mock_urlopen
'''


def output_fixture():
    return "".join(f"Compiling module {i:05d} ... done\n" for i in range(400))


def test_fixture(failure=False):
    passes = "".join(f"test_case_{i:03d} (suite.Tests.test_case_{i:03d}) ... ok\n" for i in range(100))
    diagnostic = ("test_critical ... FAIL\nTraceback (most recent call last):\n"
                  "AssertionError: actual 2 != expected 3\n") if failure else ""
    return passes + diagnostic + "Ran 101 tests in 1.23s\n" + ("FAILED (failures=1)\n" if failure else "OK\n")


def search_fixture():
    return "".join(f"{folder}/module_{i:03d}.py:{i + 1}:def found(): return {i}\n"
                   for folder in ("src/auth", "docs/archive") for i in range(120))


def event(command, output, call):
    return {"hook_event_name": "PostToolUse", "tool_name": "Bash", "session_id": "e2e-session",
            "turn_id": "e2e-turn", "tool_use_id": call,
            "tool_input": {"command": command}, "tool_response": output}


class OversizeUnitTests(unittest.TestCase):
    def test_all_routes_skip_two_megacharacter_results_before_jev(self):
        oversized = {
            "output": (jev.decide, event("echo progress", output_fixture() * 170, "too-big-output")),
            "test_build": (test_build.decide_test_build,
                           event("python3 -m unittest discover -v", test_fixture() * 410, "too-big-test")),
            "search_listing": (search_listing.decide_search_listing,
                               event("rg -n found .", search_fixture() * 180, "too-big-search")),
        }
        settings = jev.Config(enabled=True, test_build_enabled=True, search_listing_enabled=True)
        for name, (decide, item) in oversized.items():
            with self.subTest(route=name):
                self.assertGreater(len(item["tool_response"]), settings.max_chars)
                evaluator = mock.Mock(side_effect=AssertionError("Jev must not receive oversized text"))
                result = decide(item, settings, evaluator=evaluator)
                self.assertEqual(result.status, "skip")
                self.assertIn(result.reason, {"oversize", "size"})
                evaluator.assert_not_called()

    def test_near_limit_jev_state_is_bounded_for_all_routes(self):
        settings = jev.Config(enabled=True, test_build_enabled=True, search_listing_enabled=True)
        fixtures = (
            ("output", jev.decide, event("echo progress", output_fixture() * 150, "large-output")),
            ("test_build", test_build.decide_test_build,
             event("python3 -m unittest discover -v", test_fixture() * 105, "large-test")),
            ("search_listing", search_listing.decide_search_listing,
             event("rg -n found .", search_fixture() * 40, "large-search")),
        )
        for name, decide, item in fixtures:
            with self.subTest(route=name):
                self.assertLess(len(item["tool_response"]), settings.max_chars)
                seen = []
                def evaluate(state, *args):
                    seen.append((state, args))
                    if name == "search_listing":
                        return {f"group_{i}": {"type": "choice", "choice": "drop", "confidence": 0.97,
                                "probabilities": {"retain": 0.02, "summarize": 0.02, "drop": 0.96}}
                                for i in range(len(state["groups"]))}
                    return SCORES
                result = decide(item, settings, evaluator=evaluate, simulate=True)
                self.assertEqual(result.status, "replace")
                self.assertGreater(len(seen), 1 if name == "output" else 0)
                if name == "output":
                    ordered = sorted((state for state, _ in seen), key=lambda state: state["chunk_index"])
                    self.assertEqual("".join(state["output_sample"] for state in ordered), item["tool_response"])
                self.assertTrue(all(len(json.dumps(state)) < 23_000 for state, _ in seen))
                self.assertLess(result.capsule_chars, result.original_chars * 0.7)


class CommandHookEndToEndTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="jev-filter-e2e-", dir="/tmp")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data = self.root / "data"
        self.data.mkdir(mode=0o700)
        (self.data / "config.json").write_text(json.dumps({
            "enabled": True, "test_build_enabled": True,
            "search_listing_enabled": True, "mode": "replace",
        }))
        (self.data / ".env").write_text("JEV_API_KEY=synthetic-test-key\n")
        (self.data / ".env").chmod(0o600)
        (self.root / "sitecustomize.py").write_text(MOCK_HTTP)
        self.calls = self.root / "calls.jsonl"
        self.env = {**os.environ, "PLUGIN_DATA": str(self.data),
                    "JEV_MOCK_CALLS": str(self.calls),
                    "PYTHONPATH": str(self.root) + os.pathsep + os.environ.get("PYTHONPATH", "")}

    def invoke(self, item, failure=None):
        environment = {**self.env}
        if failure:
            environment["JEV_MOCK_FAILURE"] = failure
        completed = subprocess.run([sys.executable, str(HOOK)], input=json.dumps(item), text=True,
                                   capture_output=True, env=environment, timeout=15, check=True)
        self.assertEqual(completed.stderr, "")
        return json.loads(completed.stdout)

    def jev_calls(self):
        return [json.loads(row) for row in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def records(self):
        return [json.loads(row) for row in (self.data / "logs/events.jsonl").read_text().splitlines()]

    def receipts(self):
        return [json.loads(path.read_text()) for path in sorted((self.data / "logs").glob("*/receipt-*.json"))]

    def test_three_routes_batch_once_save_exact_original_and_preserve_diagnostics(self):
        fixtures = [
            ("output", event("echo progress", output_fixture(), "output")),
            ("test_build", event("python3 -m unittest discover -v", test_fixture(True), "test")),
            ("search_listing", event("rg -n found .", search_fixture(), "search")),
        ]
        for name, item in fixtures:
            with self.subTest(route=name):
                feedback = self.invoke(item)
                self.assertIs(feedback["continue"], False)
                self.assertLess(len(feedback["reason"]), len(item["tool_response"]) * 0.7)
                if name == "test_build":
                    self.assertIn("AssertionError: actual 2 != expected 3", feedback["reason"])
                    self.assertIn("FAILED (failures=1)", feedback["reason"])
                if name == "search_listing":
                    self.assertIn("src/auth/", feedback["reason"])
                    self.assertNotIn("docs/archive/module_", feedback["reason"])
                path = Path(re.search(r"Full original: ([^\n\]]+\.txt)", feedback["reason"], re.I).group(1))
                self.assertTrue(path.is_relative_to(self.data))
                self.assertEqual(path.read_text(), item["tool_response"])
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        calls = self.jev_calls()
        self.assertEqual(len(calls), 3)
        self.assertTrue(all(call["auth_ok"] for call in calls))
        self.assertEqual([len(call["questions"]) for call in calls], [4, 4, 2])
        self.assertTrue(all(len(json.dumps(call["state"])) < 20_000 for call in calls))
        receipts = self.receipts()
        self.assertEqual(len(receipts), len(calls))
        for receipt, (name, item) in zip(receipts, fixtures):
            self.assertEqual(receipt["filter"], name)
            self.assertEqual(receipt["initial_output"], item["tool_response"])
            self.assertEqual(receipt["decision"]["status"], "replace")
            self.assertEqual(receipt["call_count"], 1)
            self.assertTrue(receipt["jev_answer"])
            self.assertTrue(receipt["jev_raw_answer"])
            self.assertEqual(receipt["jev_request"]["model"], "jev-1.13.0")
            self.assertEqual(len(receipt["jev_request"]["questions"]), len(calls[fixtures.index((name, item))]["questions"]))
        rows = self.records()
        self.assertEqual([(row["filter"], row["status"]) for row in rows], [
            (name, status) for name in ("output", "test_build", "search_listing")
            for status in ("calling", "replace")])

    def test_oversize_sensitive_and_unsupported_do_not_call_jev(self):
        fixtures = [
            event("echo progress", output_fixture() * 170, "large-output"),
            event("python3 -m unittest discover -v", test_fixture() * 410, "large-test"),
            event("rg -n found .", search_fixture() * 180, "large-search"),
            event("echo progress", output_fixture() + "api_key: hidden\n", "sensitive"),
            event("cat file.py", "plain text\n" * 600, "unsupported"),
        ]
        for item in fixtures:
            with self.subTest(call=item["tool_use_id"]):
                self.assertEqual(self.invoke(item), {})
        self.assertEqual(self.jev_calls(), [])
        self.assertEqual(self.receipts(), [])
        self.assertFalse((self.data / "outputs").exists())
        self.assertTrue(all(row["status"] == "skip" for row in self.records()))

    def test_large_output_is_checked_in_bounded_chunks_and_saved_exactly(self):
        item = event("echo progress", output_fixture() * 12, "chunked-output")
        feedback = self.invoke(item)
        receipts = self.receipts()
        self.assertEqual(len(receipts), len(self.jev_calls()))
        self.assertGreater(len(receipts), 1)
        self.assertEqual([receipt["call_index"] for receipt in receipts], list(range(1, len(receipts) + 1)))
        self.assertTrue(all(receipt["call_count"] == len(receipts) and
                            receipt["initial_output"] == item["tool_response"] and
                            receipt["visible_output"] == feedback["reason"] for receipt in receipts))
        self.assertEqual("".join(receipt["jev_request"]["state"]["output_sample"] for receipt in receipts),
                         item["tool_response"])
        self.assertIs(feedback["continue"], False)
        calls = self.jev_calls()
        self.assertGreater(len(calls), 1)
        ordered = sorted(calls, key=lambda call: call["state"]["chunk_index"])
        self.assertEqual("".join(call["state"]["output_sample"] for call in ordered), item["tool_response"])
        self.assertTrue(all(call["auth_ok"] for call in calls))
        self.assertTrue(all(call["request_bytes"] <= jev.MAX_JEV_REQUEST_BYTES for call in calls))
        original = next((self.data / "outputs").rglob("*.txt"))
        self.assertEqual(original.read_text(), item["tool_response"])

    def test_jev_error_or_invalid_json_fails_open_on_each_route(self):
        fixtures = [
            event("echo progress", output_fixture(), "output-failure"),
            event("python3 -m unittest discover -v", test_fixture(), "test-failure"),
            event("rg -n found .", search_fixture(), "search-failure"),
        ]
        for failure in ("exit", "malformed"):
            for item in fixtures:
                with self.subTest(failure=failure, call=item["tool_use_id"]):
                    self.assertEqual(self.invoke(item, failure), {})
        self.assertEqual(len(self.jev_calls()), 6)
        receipts = self.receipts()
        self.assertEqual(len(receipts), 6)
        self.assertTrue(all(receipt["decision"]["status"] == "keep" and
                            receipt["visible_output"] == receipt["initial_output"] and
                            receipt["jev_error"] in {"OSError", "JSONDecodeError"} for receipt in receipts))
        self.assertFalse((self.data / "outputs").exists())
        self.assertEqual([row["status"] for row in self.records() if row["status"] != "calling"],
                         ["keep"] * 6)


if __name__ == "__main__":
    unittest.main()
