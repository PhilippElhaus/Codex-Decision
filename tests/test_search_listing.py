import contextlib
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hooks"))
import jev  # noqa: E402
import post_tool_use  # noqa: E402
import search_listing  # noqa: E402


def event(command, output, call="search-1", transcript=None):
    data = {
        "session_id": "search-session", "turn_id": "search-turn", "tool_use_id": call,
        "hook_event_name": "PostToolUse", "tool_name": "Bash",
        "tool_input": {"command": command}, "tool_response": output,
    }
    if transcript:
        data["transcript_path"] = str(transcript)
    return data


def hits():
    return "".join(
        f"{folder}/module_{i % 7}.py:{i + 1}:def function_{i:03d}(): return {i}\n"
        for folder in ("app/auth", "docs/archive") for i in range(95)
    )


def listing():
    return "".join(f"{folder}/module_{i:03d}.py\n" for folder in ("app/auth", "docs/archive") for i in range(110))


def choices(state, questions, _config, over=None):
    over = over or {}
    result = {}
    for index, group in enumerate(state["groups"]):
        choice = over.get(group["path"], "retain")
        result[f"group_{index}"] = {
            "type": "choice", "choice": choice,
            "probabilities": {key: 0.96 if key == choice else 0.02 for key in ("retain", "summarize", "drop")},
            "confidence": 0.96,
        }
    return result


class SearchListingTests(unittest.TestCase):
    def config(self, **changes):
        return jev.Config(search_listing_enabled=True, **changes)

    def test_threshold_controls_group_omission(self):
        answer = {"type": "choice", "choice": "drop", "probabilities":
                  {"retain": .02, "summarize": .02, "drop": .96}, "confidence": .90}
        self.assertEqual(search_listing._decision(answer), "drop")
        strict = self.config(thresholds={"search_listing": {"drop_confidence_min": 95}})
        self.assertEqual(search_listing._decision(answer, strict), "summarize")

    def test_command_gate_accepts_simple_searches_and_listings_only(self):
        accepted = {
            "rg -n function app": "search", "rg --line-number -F 'status' app": "search",
            "rg -n -- 'my pattern' app": "search", "rg --files -g '*.py'": "listing",
            "git ls-files": "listing",
        }
        for command, kind in accepted.items():
            with self.subTest(command=command):
                self.assertEqual(search_listing.command_kind({"command": command}), kind)
        for command in ("rg function app", "rg -n function | head", "rg -n --json function", "rg -n -C 2 function", "rg -n -o function", "rg --files -0", "git status", "rg -n $(cat query)", "rg -n pattern > out", "cat file.py"):
            with self.subTest(command=command):
                self.assertIsNone(search_listing.command_kind({"command": command}))

    def test_search_retains_relevant_group_and_replaces_irrelevant_group(self):
        output = hits()
        with tempfile.TemporaryDirectory(prefix="jev-search-", dir="/tmp") as directory:
            root = Path(directory)
            answer = lambda state, questions, config: choices(state, questions, config, {"docs/archive": "drop"})
            result = search_listing.decide_search_listing(event("rg -n function .", output), self.config(), answer, root)
            self.assertEqual(result.status, "replace")
            self.assertIn("app/auth/module_", result.hook_output["reason"])
            self.assertNotIn("docs/archive/module_", result.hook_output["reason"])
            self.assertLess(result.capsule_chars, result.original_chars * 0.7)
            original = list((root / "outputs").rglob("*.txt"))
            self.assertEqual(len(original), 1)
            self.assertEqual(original[0].read_text(), output)
            self.assertIn(str(original[0]), result.hook_output["reason"])

    def test_uncertain_choices_keep_exact_output(self):
        output = hits()
        def uncertain(state, questions, config):
            answer = choices(state, questions, config, {"docs/archive": "drop"})
            answer["group_1"]["confidence"] = 0.3
            return answer
        with tempfile.TemporaryDirectory(prefix="jev-search-", dir="/tmp") as directory:
            result = search_listing.decide_search_listing(event("rg -n function .", output), self.config(), uncertain, Path(directory))
            self.assertEqual(result.status, "keep")
            self.assertEqual(result.reason, "jev_keep")
            self.assertFalse((Path(directory) / "outputs").exists())

    def test_invalid_choices_and_storage_failure_keep_exact_output(self):
        output = hits()
        with tempfile.TemporaryDirectory(prefix="jev-search-", dir="/tmp") as directory:
            root = Path(directory)
            malformed = lambda state, questions, config: {"group_0": {"choice": "drop"}}
            bad = search_listing.decide_search_listing(event("rg -n function .", output), self.config(), malformed, root)
            self.assertEqual(bad.reason, "evaluator_unavailable")
            answer = lambda state, questions, config: choices(state, questions, config, {"docs/archive": "drop"})
            with mock.patch.object(search_listing, "save_original", side_effect=OSError("disk full")):
                failed = search_listing.decide_search_listing(event("rg -n function .", output), self.config(), answer, root)
            self.assertEqual(failed.reason, "storage_unavailable")
            self.assertIsNone(failed.hook_output)

    def test_observe_and_api_failure_leave_result_visible(self):
        output = hits()
        answer = lambda state, questions, config: choices(state, questions, config, {"docs/archive": "drop"})
        with tempfile.TemporaryDirectory(prefix="jev-search-", dir="/tmp") as directory:
            root = Path(directory)
            observed = search_listing.decide_search_listing(event("rg -n function .", output), self.config(mode="observe"), answer, root)
            self.assertEqual(observed.status, "candidate")
            self.assertIsNone(observed.hook_output)
            failed = search_listing.decide_search_listing(event("rg -n function .", output), self.config(), lambda *_: (_ for _ in ()).throw(TimeoutError()), root)
            self.assertEqual(failed.reason, "evaluator_unavailable")
            self.assertFalse((root / "outputs").exists())

    def test_local_gates_make_no_jev_request(self):
        output = hits()
        evaluator = mock.Mock()
        fixtures = [
            event("rg -n function .", "tiny"),
            event("rg -n function .", output.replace(":def", "=def", 1)),
            event("rg -n function .", output + "authorization: bearer abcdefghijklmnop\n"),
            event("rg -n function .", output, call="x") | {"tool_response": {"text": output}},
            event("rg --files", listing()),  # no task hint
        ]
        for item in fixtures:
            with self.subTest(item=item["tool_input"]["command"], response=str(item["tool_response"])[:20]):
                result = search_listing.decide_search_listing(item, self.config(), evaluator)
                self.assertEqual(result.status, "skip")
        evaluator.assert_not_called()

    def test_listing_uses_bounded_latest_user_goal(self):
        with tempfile.TemporaryDirectory(prefix="jev-search-", dir="/tmp") as directory:
            root = Path(directory)
            transcript = root / "thread.jsonl"
            row = {"type": "response_item", "payload": {"role": "user", "content": [{"type": "input_text", "text": "Find the auth implementation."}]}}
            transcript.write_text(json.dumps(row) + "\n")
            seen = []
            def evaluate(state, questions, config):
                seen.append(state)
                return choices(state, questions, config, {"docs/archive": "summarize"})
            result = search_listing.decide_search_listing(event("rg --files", listing(), transcript=transcript), self.config(), evaluate, root)
            self.assertEqual(result.status, "replace")
            self.assertEqual(seen[0]["task"], "Find the auth implementation.")
            self.assertLess(len(json.dumps(seen[0])), search_listing.MAX_STATE_CHARS)

    def test_legacy_precompact_setting_is_ignored_without_enabling_third_filter(self):
        with tempfile.TemporaryDirectory(prefix="jev-search-", dir="/tmp") as directory:
            path = Path(directory) / "config.json"
            path.write_text('{"enabled":true,"precompact_enabled":true}')
            config = jev.Config.from_file(path)
            self.assertTrue(config.enabled)
            self.assertFalse(config.search_listing_enabled)

    def test_adapter_routes_one_request_per_result_and_live_config_toggle(self):
        output = hits()
        with tempfile.TemporaryDirectory(prefix="jev-search-", dir="/tmp") as directory:
            root = Path(directory)
            (root / ".env").write_text("JEV_API_KEY=synthetic-test-key\n")
            (root / ".env").chmod(0o600)
            path = root / "config.json"
            calls = []
            def call(call_id):
                printed = io.StringIO()
                with (mock.patch.dict(os.environ, {"PLUGIN_DATA": directory}),
                      mock.patch.object(sys, "stdin", io.StringIO(json.dumps(event("rg -n function .", output, call_id)))),
                      mock.patch.object(post_tool_use, "jev_choice_request", side_effect=lambda state, questions, config, key: calls.append("search") or choices(state, questions, config, {"docs/archive": "drop"})),
                      mock.patch.object(post_tool_use, "jev_request", side_effect=lambda *_: calls.append("output")),
                      mock.patch.object(post_tool_use, "jev_test_build_request", side_effect=lambda *_: calls.append("test")),
                      contextlib.redirect_stdout(printed)):
                    post_tool_use.main()
                return json.loads(printed.getvalue())
            path.write_text('{"enabled":true,"test_build_enabled":true,"search_listing_enabled":false}')
            self.assertEqual(call("off"), {})
            self.assertEqual(calls, [])
            path.write_text('{"enabled":true,"test_build_enabled":true,"search_listing_enabled":true}')
            self.assertIs(call("on")["continue"], False)
            self.assertEqual(calls, ["search"])
            path.write_text('{"enabled":false,"test_build_enabled":false,"search_listing_enabled":false}')
            self.assertEqual(call("off-again"), {})
            self.assertEqual(calls, ["search"])
            logs = [json.loads(row) for row in (root / "events.jsonl").read_text().splitlines()]
            self.assertEqual([(row["filter"], row["status"]) for row in logs], [("output", "skip"), ("search_listing", "calling"), ("search_listing", "replace")])


if __name__ == "__main__":
    unittest.main()
