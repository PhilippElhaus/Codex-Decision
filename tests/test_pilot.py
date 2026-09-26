import io
import contextlib
import json
import os
from pathlib import Path
import random
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hooks"))
sys.path.insert(0, str(ROOT / "scripts"))
import pilot  # noqa: E402
import post_tool_use  # noqa: E402
import replay  # noqa: E402


GOOD = {"routine_noise": 0.99, "needs_exact_text": 0.01, "one_off_value": 0.01}
BAD = {"routine_noise": 0.01, "needs_exact_text": 0.99, "one_off_value": 0.99}
PROGRESS = "".join(f"Compiling module {n:05d} ... done\n" for n in range(400))


def event(output=PROGRESS, tool="Bash", command="build --verbose"):
    return {
        "session_id": "session-1",
        "turn_id": "turn-1",
        "tool_use_id": "tool-1",
        "hook_event_name": "PostToolUse",
        "tool_name": tool,
        "tool_input": {"command": command},
        "tool_response": output,
    }


def settings(**kwargs):
    return pilot.Config(enabled=True, mode="replace", **kwargs)


class ConfigTests(unittest.TestCase):
    def test_default_is_disabled_and_observe_only(self):
        self.assertFalse(pilot.Config().enabled)
        self.assertEqual(pilot.Config().mode, "observe")

    def test_config_example_is_valid_and_disabled(self):
        config = pilot.Config.from_file(ROOT / "config.example.json")
        self.assertFalse(config.enabled)
        self.assertEqual(config.mode, "observe")

    def test_invalid_configs_fail_closed(self):
        for invalid in ({"enabled": "true"}, {"mode": "destroy"}, {"min_chars": 10}, {"unknown": 1}, {"timeout_seconds": 10}):
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "config.json"
                path.write_text(json.dumps(invalid), encoding="utf-8")
                with self.assertRaises(ValueError):
                    pilot.Config.from_file(path)

    def test_manifest_has_only_one_inactive_by_default_hook(self):
        manifest = json.loads((ROOT / ".codex-plugin" / "plugin.json").read_text())
        hooks = json.loads((ROOT / "hooks" / "hooks.json").read_text())
        self.assertEqual(manifest["name"], ROOT.name)
        self.assertEqual(set(hooks["hooks"]), {"PostToolUse"})
        self.assertFalse(hooks["hooks"]["PostToolUse"][0]["hooks"][0].get("async", False))


class SafetyTests(unittest.TestCase):
    def test_disabled_skips_without_evaluator(self):
        evaluator = mock.Mock()
        outcome = pilot.decide(event(), pilot.Config(), evaluator=evaluator)
        self.assertEqual(outcome.reason, "disabled")
        evaluator.assert_not_called()

    def test_only_supported_event_and_text_shapes(self):
        for payload in (
            {**event(), "hook_event_name": "Stop"},
            event({"output": PROGRESS}),
            event(PROGRESS, tool="apply_patch"),
            event({"content": [{"type": "image", "data": "a"}]}, tool="mcp__demo__scan"),
            event({"isError": True, "content": [{"type": "text", "text": PROGRESS}]}, tool="mcp__demo__scan"),
            event({"content": [{"type": "text", "text": PROGRESS}, {"type": "image", "data": "a"}]}, tool="mcp__demo__scan"),
            event({"content": [{"type": "text", "text": PROGRESS}], "structuredContent": {"data": 1}}, tool="mcp__demo__scan"),
        ):
            with self.subTest(payload=payload["tool_name"]):
                evaluator = mock.Mock()
                result = pilot.decide(payload, settings(), evaluator=evaluator)
                self.assertEqual(result.status, "skip")
                evaluator.assert_not_called()

    def test_small_oversize_and_distinct_search_hits_skip_jev(self):
        distinct = "".join(f"src/file_{n}.py:{n}: distinct finding {n}\n" for n in range(500))
        for output, config, reason in (
            ("ok", settings(), "small"),
            (PROGRESS, settings(max_chars=8192), "oversize"),
            (distinct, settings(), "not_repetitive"),
        ):
            with self.subTest(reason=reason):
                evaluator = mock.Mock()
                result = pilot.decide(event(output), config, evaluator=evaluator)
                self.assertEqual(result.reason, reason)
                evaluator.assert_not_called()

    def test_error_or_secret_at_any_position_keeps_full_output(self):
        rng = random.Random(42)
        for marker, reason in (("ERROR: link failed\n", "diagnostic"), ("api_key = secret-value\n", "sensitive")):
            for _ in range(100):
                position = rng.randrange(len(PROGRESS))
                output = PROGRESS[:position] + marker + PROGRESS[position:]
                evaluator = mock.Mock()
                result = pilot.decide(event(output), settings(), evaluator=evaluator)
                self.assertEqual(result.reason, reason)
                evaluator.assert_not_called()

    def test_sensitive_input_is_not_sent_to_jev(self):
        evaluator = mock.Mock()
        result = pilot.decide(event(command="run password=secret-value"), settings(), evaluator=evaluator)
        self.assertEqual(result.reason, "sensitive")
        evaluator.assert_not_called()

    def test_missing_failed_or_malformed_evaluator_keeps_original(self):
        for evaluator in (None, lambda _state, _config: 1 / 0, lambda _state, _config: {"routine_noise": 0.99}, lambda _state, _config: {**GOOD, "one_off_value": 2.0}):
            with self.subTest(evaluator=evaluator):
                result = pilot.decide(event(), settings(), evaluator=evaluator)
                self.assertEqual(result.status, "skip" if evaluator is None else "keep")
                self.assertEqual(result.hook_output, None)

    def test_all_three_scores_must_pass_conservative_thresholds(self):
        for scores in (BAD, {**GOOD, "routine_noise": 0.899}, {**GOOD, "needs_exact_text": 0.121}, {**GOOD, "one_off_value": 0.101}):
            with self.subTest(scores=scores):
                result = pilot.decide(event(), settings(), evaluator=lambda *_: scores, simulate=True)
                self.assertEqual(result.reason, "jev_keep")


class ReplacementTests(unittest.TestCase):
    def test_observe_never_writes_or_changes_hook_output(self):
        with tempfile.TemporaryDirectory() as directory:
            result = pilot.decide(event(), pilot.Config(enabled=True, mode="observe"), evaluator=lambda *_: GOOD, storage=Path(directory))
            self.assertEqual(result.status, "candidate")
            self.assertIsNone(result.hook_output)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_replacement_saves_exact_original_with_private_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            result = pilot.decide(event(), settings(), evaluator=lambda *_: GOOD, storage=Path(directory))
            self.assertEqual(result.status, "replace")
            self.assertEqual(result.hook_output["continue"], False)
            self.assertIn("Full original:", result.hook_output["reason"])
            files = list(Path(directory).rglob("*.txt"))
            self.assertEqual(len(files), 1)
            self.assertEqual(files[0].read_text(), PROGRESS)
            self.assertEqual(stat.S_IMODE(files[0].stat().st_mode), 0o600)
            self.assertLess(result.capsule_chars, result.original_chars // 5)

    def test_repeat_tool_id_fails_open_instead_of_overwriting_original(self):
        with tempfile.TemporaryDirectory() as directory:
            first = pilot.decide(event(), settings(), evaluator=lambda *_: GOOD, storage=Path(directory))
            second = pilot.decide(event(), settings(), evaluator=lambda *_: GOOD, storage=Path(directory))
            self.assertEqual(first.status, "replace")
            self.assertEqual(second.reason, "storage_unavailable")
            self.assertEqual(list(Path(directory).rglob("*.txt"))[0].read_text(), PROGRESS)

    def test_invalid_ids_fail_open(self):
        with tempfile.TemporaryDirectory() as directory:
            payload = {**event(), "session_id": "../../escape"}
            result = pilot.decide(payload, settings(), evaluator=lambda *_: GOOD, storage=Path(directory))
            self.assertEqual(result.reason, "storage_unavailable")

    def test_symlinked_storage_fails_open(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            target.mkdir()
            alias = root / "alias"
            alias.symlink_to(target, target_is_directory=True)
            result = pilot.decide(event(), settings(), evaluator=lambda *_: GOOD, storage=alias)
            self.assertEqual(result.reason, "storage_unavailable")
            self.assertEqual(list(target.iterdir()), [])

    def test_mcp_is_observed_until_separately_enabled(self):
        payload = event({"content": [{"type": "text", "text": PROGRESS}]}, tool="mcp__demo__logs")
        default = pilot.decide(payload, settings(), evaluator=lambda *_: GOOD, simulate=True)
        allowed = pilot.decide(payload, settings(allow_mcp_replacement=True), evaluator=lambda *_: GOOD, simulate=True)
        self.assertEqual(default.reason, "mcp_observe_only")
        self.assertEqual(allowed.status, "replace")


class ContractTests(unittest.TestCase):
    def test_hook_adapter_replace_contract_with_mock_jev(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "config.json").write_text(json.dumps({"enabled": True, "mode": "replace"}))
            printed = io.StringIO()
            with (
                mock.patch.dict(os.environ, {"PLUGIN_DATA": directory, "TYPESAFE_API_KEY": "test-key"}),
                mock.patch.object(sys, "stdin", io.StringIO(json.dumps(event()))),
                mock.patch.object(post_tool_use, "jev_request", return_value=GOOD) as jev,
                contextlib.redirect_stdout(printed),
            ):
                post_tool_use.main()
            result = json.loads(printed.getvalue())
            self.assertEqual(result["continue"], False)
            self.assertIn("Full original:", result["reason"])
            self.assertEqual(len(list(Path(directory).rglob("*.txt"))), 1)
            records = [json.loads(line) for line in Path(directory, "events.jsonl").read_text().splitlines()]
            self.assertEqual([record["status"] for record in records], ["calling", "replace"])
            self.assertNotIn("Compiling module", json.dumps(records))
            jev.assert_called_once()
            self.assertEqual(jev.call_args.args[2], "")

    def test_type_safe_request_uses_three_nouls_and_checks_response(self):
        response = {"model": "jev-1.13.0", "answers": {key: {"type": "noul", "noul": value} for key, value in GOOD.items()}}
        fake = io.BytesIO(json.dumps(response).encode())
        with mock.patch.object(pilot.request, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value = fake
            scores = pilot.jev_request({"tool": "Bash", "output_sample": "text"}, settings(), "test-key")
        req = urlopen.call_args.args[0]
        self.assertEqual(req.full_url, pilot.ENDPOINT)
        self.assertEqual(req.get_header("Authorization"), "Bearer test-key")
        sent = json.loads(req.data)
        self.assertEqual(set(sent["questions"]), set(pilot.SCORE_NAMES))
        self.assertTrue(all(question["type"] == "noul" for question in sent["questions"].values()))
        self.assertEqual(scores, GOOD)

    def test_windows_bridge_sends_only_encoded_request_and_parses_scores(self):
        answer = {"model": "jev-1.13.0", "answers": {name: {"type": "noul", "noul": value} for name, value in GOOD.items()}}
        completed = subprocess.CompletedProcess([], 0, stdout=json.dumps(answer).encode(), stderr=b"")
        with mock.patch.object(pilot.subprocess, "run", return_value=completed) as run:
            scores = pilot.jev_request({"tool": "Bash", "output_sample": "text"}, settings(), "")
        self.assertEqual(scores, GOOD)
        command = run.call_args.args[0]
        self.assertEqual(command[0], "pwsh.exe")
        self.assertNotIn("test-key", " ".join(command))
        encoded = run.call_args.kwargs["input"]
        self.assertEqual(set(json.loads(__import__("base64").b64decode(encoded))["questions"]), set(pilot.SCORE_NAMES))

    def test_command_hook_disabled_without_plugin_data(self):
        hook = ROOT / "hooks" / "post_tool_use.py"
        env = {**os.environ}
        env.pop("PLUGIN_DATA", None)
        run = subprocess.run([sys.executable, str(hook)], input=json.dumps(event()), text=True, capture_output=True, env=env, check=True)
        self.assertEqual(run.stdout.strip(), "{}")
        self.assertEqual(run.stderr, "")

    def test_command_hook_bridge_failure_keeps_output_and_logs_metadata_only(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "config.json").write_text(json.dumps({"enabled": True, "mode": "observe"}))
            output = io.StringIO()
            with (
                mock.patch.dict(os.environ, {"PLUGIN_DATA": directory}, clear=False),
                mock.patch.object(sys, "stdin", io.StringIO(json.dumps(event()))),
                mock.patch.object(post_tool_use, "jev_request", side_effect=RuntimeError("bridge unavailable")),
                contextlib.redirect_stdout(output),
            ):
                post_tool_use.main()
            self.assertEqual(output.getvalue().strip(), "{}")
            log = Path(directory, "events.jsonl").read_text()
            self.assertIn("evaluator_unavailable", log)
            self.assertIn('"status":"calling"', log)
            self.assertNotIn("Compiling module", log)


class ReplayTests(unittest.TestCase):
    def test_1000_case_offline_corpus_has_no_policy_false_replacements(self):
        report = replay.run(replay.generated_cases(100), live=False, mode="replace", config=pilot.Config())
        self.assertEqual(report["kind"], "OFFLINE POLICY REPLAY (mock Jev scores)")
        self.assertEqual(report["cases"], 1000)
        self.assertEqual(report["false_replacements"], 0)
        self.assertEqual(report["missed_replacements"], 0)
        self.assertEqual(report["simulated_replacements"], 100)


if __name__ == "__main__":
    unittest.main()
