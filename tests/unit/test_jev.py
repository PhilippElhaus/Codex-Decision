import io
import contextlib
import json
import os
from pathlib import Path
import random
import stat
import struct
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "hooks"))
sys.path.insert(0, str(ROOT / "scripts"))
import jev  # noqa: E402
import post_tool_use  # noqa: E402
import replay  # noqa: E402
import benchmark_context  # noqa: E402
import migrate_legacy_data  # noqa: E402
import configure_key  # noqa: E402


GOOD = {"routine_noise": 0.99, "needs_exact_text": 0.01, "one_off_value": 0.01,
        "filter_approved": True, "filter_confidence": 0.96}
BAD = {"routine_noise": 0.01, "needs_exact_text": 0.99, "one_off_value": 0.99,
       "filter_approved": False, "filter_confidence": 0.96}
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
    return jev.Config(enabled=True, mode="replace", **kwargs)


class ConfigTests(unittest.TestCase):
    def test_legacy_data_migration_preserves_originals_and_rejects_conflicts(self):
        with tempfile.TemporaryDirectory(prefix="jev-data-migration-", dir="/tmp") as directory:
            old = Path(directory) / "old"
            new = Path(directory) / "new"
            (old / "outputs" / "session").mkdir(parents=True)
            (old / "config.json").write_text('{"enabled":true,"mode":"replace"}')
            (old / "events.jsonl").write_text('{"status":"keep"}\n')
            (old / "outputs" / "session" / "call.txt").write_text("exact original")
            self.assertEqual(migrate_legacy_data.migrate(old, new)["copied"], 3)
            self.assertEqual(migrate_legacy_data.migrate(old, new)["already_present"], 3)
            self.assertEqual((new / "outputs" / "session" / "call.txt").read_text(), "exact original")
            self.assertEqual((old / "outputs" / "session" / "call.txt").read_text(), "exact original")
            self.assertEqual(stat.S_IMODE(new.stat().st_mode), 0o700)
            (new / "config.json").write_text("conflict")
            with self.assertRaises(ValueError):
                migrate_legacy_data.migrate(old, new)
            (new / "config.json").unlink()
            (new / "config.json").symlink_to(old / "config.json")
            with self.assertRaises(ValueError):
                migrate_legacy_data.migrate(old, new)

    def test_default_is_disabled_with_replacement_mode(self):
        self.assertFalse(jev.Config().enabled)
        self.assertFalse(jev.Config().test_build_enabled)
        self.assertFalse(jev.Config().search_listing_enabled)
        self.assertEqual(jev.Config().mode, "replace")

    def test_config_example_is_valid_and_disabled(self):
        config = jev.Config.from_file(ROOT / "config.example.json")
        self.assertFalse(config.enabled)
        self.assertFalse(config.test_build_enabled)
        self.assertFalse(config.search_listing_enabled)
        self.assertEqual(config.mode, "replace")

    def test_output_threshold_changes_decision_and_invalid_values_fail(self):
        scores = {**GOOD, "routine_noise": .94, "needs_exact_text": .08, "one_off_value": .05}
        self.assertTrue(jev.candidate(scores))
        stricter = jev.Config(thresholds={"output": {"routine_min": 96}})
        self.assertFalse(jev.candidate(scores, stricter))
        with tempfile.TemporaryDirectory(prefix="jev-thresholds-", dir="/tmp") as directory:
            path = Path(directory) / "config.json"
            path.write_text(json.dumps({"thresholds": {"output": {"routine_min": 96}}}))
            self.assertFalse(jev.candidate(scores, jev.Config.from_file(path)))
            path.write_text(json.dumps({"thresholds": {"output": {"routine_min": 101}}}))
            with self.assertRaises(ValueError):
                jev.Config.from_file(path)

    def test_filter_requires_jev_choice_and_its_reported_confidence(self):
        self.assertFalse(jev.candidate({**GOOD, "filter_approved": False}))
        self.assertFalse(jev.candidate({**GOOD, "filter_confidence": .69}))
        self.assertTrue(jev.candidate({**GOOD, "filter_confidence": .70}))
        strict = jev.Config(thresholds={"output": {"confidence_min": 97}})
        self.assertFalse(jev.candidate(GOOD, strict))

    def test_invalid_configs_fail_closed(self):
        for invalid in ({"enabled": "true"}, {"test_build_enabled": "true"}, {"search_listing_enabled": "true"}, {"mode": "destroy"}, {"min_chars": 10}, {"unknown": 1}, {"timeout_seconds": 10}):
            with self.subTest(invalid=invalid), tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "config.json"
                path.write_text(json.dumps(invalid), encoding="utf-8")
                with self.assertRaises(ValueError):
                    jev.Config.from_file(path)

    def test_manifest_has_three_inactive_by_default_hooks(self):
        manifest = json.loads((ROOT / ".codex-plugin" / "plugin.json").read_text())
        hooks = json.loads((ROOT / "hooks" / "hooks.json").read_text())
        self.assertEqual(manifest["name"], ROOT.name.lower())
        self.assertEqual(manifest["interface"]["displayName"], "Codex Jev")
        for field, size in (("logo", 256), ("composerIcon", 64)):
            image = ROOT / manifest["interface"][field]
            data = image.read_bytes()
            self.assertEqual(data[:8], b"\x89PNG\r\n\x1a\n")
            self.assertEqual(struct.unpack(">II", data[16:24]), (size, size))
        self.assertEqual(set(hooks["hooks"]), {"PostToolUse"})
        for event in hooks["hooks"]:
            self.assertFalse(hooks["hooks"][event][0]["hooks"][0].get("async", False))

    def test_hook_launcher_fails_open_when_cache_disappears_or_script_fails(self):
        hooks = json.loads((ROOT / "hooks" / "hooks.json").read_text())
        command = hooks["hooks"]["PostToolUse"][0]["hooks"][0]["command"]
        with tempfile.TemporaryDirectory(prefix="jev-launcher-", dir="/tmp") as directory:
            environment = {**os.environ, "PLUGIN_ROOT": directory}
            missing = subprocess.run(command, shell=True, input="{}", text=True,
                                     capture_output=True, env=environment, check=True)
            self.assertEqual(missing.stdout, "")
            hook_dir = Path(directory) / "hooks"
            hook_dir.mkdir()
            (hook_dir / "post_tool_use.py").write_text("raise SystemExit(99)\n")
            failing = subprocess.run(command, shell=True, input="{}", text=True,
                                     capture_output=True, env=environment, check=True)
            self.assertEqual(failing.stdout, "")


class SafetyTests(unittest.TestCase):
    def test_disabled_skips_without_evaluator(self):
        evaluator = mock.Mock()
        outcome = jev.decide(event(), jev.Config(), evaluator=evaluator)
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
                result = jev.decide(payload, settings(), evaluator=evaluator)
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
                result = jev.decide(event(output), config, evaluator=evaluator)
                self.assertEqual(result.reason, reason)
                evaluator.assert_not_called()

    def test_error_or_secret_at_any_position_keeps_full_output(self):
        rng = random.Random(42)
        for marker, reason in (("ERROR: link failed\n", "diagnostic"), ("api_key = secret-value\n", "sensitive")):
            for _ in range(100):
                position = rng.randrange(len(PROGRESS))
                output = PROGRESS[:position] + marker + PROGRESS[position:]
                evaluator = mock.Mock()
                result = jev.decide(event(output), settings(), evaluator=evaluator)
                self.assertEqual(result.reason, reason)
                evaluator.assert_not_called()

    def test_sensitive_input_is_not_sent_to_jev(self):
        evaluator = mock.Mock()
        result = jev.decide(event(command="run password=secret-value"), settings(), evaluator=evaluator)
        self.assertEqual(result.reason, "sensitive")
        evaluator.assert_not_called()

    def test_large_output_keeps_original_if_any_chunk_has_unique_value(self):
        routine = PROGRESS * 12
        output = routine[:len(routine) // 4] + "receipt id: fixture-only-9XQ7\n" + routine[len(routine) // 4:]
        self.assertNotIn("receipt id:", jev.sample(output, settings().sample_chars))
        calls = []
        def evaluate(state, _config):
            calls.append(state)
            return BAD if "receipt id:" in state["output_sample"] else GOOD
        result = jev.decide(event(output), settings(), evaluator=evaluate, simulate=True)
        self.assertEqual(result.reason, "jev_keep")
        self.assertGreater(len(calls), 1)
        self.assertEqual("".join(state["output_sample"] for state in sorted(calls, key=lambda state: state["chunk_index"])), output)

    def test_large_output_keeps_original_if_one_chunk_has_low_choice_confidence(self):
        output = PROGRESS * 8
        result = jev.decide(event(output), settings(), evaluator=lambda state, _: {
            **GOOD, "filter_confidence": .69 if state["chunk_index"] == 2 else .96,
        }, simulate=True)
        self.assertEqual(result.reason, "jev_keep")
        self.assertEqual(result.scores["filter_confidence"], .69)
        disagreed = jev.decide(event(output), settings(), evaluator=lambda state, _: {
            **GOOD, "filter_approved": state["chunk_index"] != 2,
        }, simulate=True)
        self.assertEqual(disagreed.reason, "jev_keep")
        self.assertIs(disagreed.scores["filter_approved"], False)

    def test_chunk_limit_keeps_large_output_without_partial_judgment(self):
        output = PROGRESS * 120
        evaluator = mock.Mock(return_value=GOOD)
        with mock.patch.object(jev, "MAX_CHUNKS", 2):
            result = jev.decide(event(output), settings(), evaluator=evaluator, simulate=True)
        self.assertEqual(result.reason, "too_many_chunks")
        evaluator.assert_not_called()

    def test_multibyte_and_escaped_text_is_covered_without_oversized_chunks(self):
        output = 'Compiling 狐🦊 "quoted"\tmodule 001 ... done\n' * 1000
        seen = []
        result = jev.decide(event(output), settings(),
                            evaluator=lambda state, _config: seen.append(state) or GOOD,
                            simulate=True)
        self.assertEqual(result.status, "replace")
        ordered = sorted(seen, key=lambda state: state["chunk_index"])
        self.assertEqual("".join(state["output_sample"] for state in ordered), output)
        self.assertTrue(all(len(json.dumps(state["output_sample"], ensure_ascii=False).encode())
                            <= jev.CHUNK_JSON_BYTES for state in ordered))

    def test_chunk_request_failure_keeps_original(self):
        output = PROGRESS * 8
        def evaluate(state, _config):
            if state["chunk_index"] == 2:
                raise OSError("Jev unavailable")
            return GOOD
        result = jev.decide(event(output), settings(), evaluator=evaluate, simulate=True)
        self.assertEqual(result.reason, "evaluator_unavailable")
        self.assertIsNone(result.hook_output)

    def test_missing_failed_or_malformed_evaluator_keeps_original(self):
        for evaluator in (None, lambda _state, _config: 1 / 0, lambda _state, _config: {"routine_noise": 0.99}, lambda _state, _config: {**GOOD, "one_off_value": 2.0}):
            with self.subTest(evaluator=evaluator):
                result = jev.decide(event(), settings(), evaluator=evaluator)
                self.assertEqual(result.status, "skip" if evaluator is None else "keep")
                self.assertEqual(result.hook_output, None)

    def test_all_three_scores_must_pass_conservative_thresholds(self):
        for scores in (BAD, {**GOOD, "routine_noise": 0.899}, {**GOOD, "needs_exact_text": 0.121}, {**GOOD, "one_off_value": 0.101}):
            with self.subTest(scores=scores):
                result = jev.decide(event(), settings(), evaluator=lambda *_: scores, simulate=True)
                self.assertEqual(result.reason, "jev_keep")


class ReplacementTests(unittest.TestCase):
    def test_observe_never_writes_or_changes_hook_output(self):
        with tempfile.TemporaryDirectory() as directory:
            result = jev.decide(event(), jev.Config(enabled=True, mode="observe"), evaluator=lambda *_: GOOD, storage=Path(directory))
            self.assertEqual(result.status, "candidate")
            self.assertIsNone(result.hook_output)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_replacement_saves_exact_original_with_private_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            result = jev.decide(event(), settings(), evaluator=lambda *_: GOOD, storage=Path(directory))
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
            first = jev.decide(event(), settings(), evaluator=lambda *_: GOOD, storage=Path(directory))
            second = jev.decide(event(), settings(), evaluator=lambda *_: GOOD, storage=Path(directory))
            self.assertEqual(first.status, "replace")
            self.assertEqual(second.reason, "storage_unavailable")
            self.assertEqual(list(Path(directory).rglob("*.txt"))[0].read_text(), PROGRESS)

    def test_invalid_ids_fail_open(self):
        with tempfile.TemporaryDirectory() as directory:
            payload = {**event(), "session_id": "../../escape"}
            result = jev.decide(payload, settings(), evaluator=lambda *_: GOOD, storage=Path(directory))
            self.assertEqual(result.reason, "storage_unavailable")

    def test_symlinked_storage_fails_open(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            target.mkdir()
            alias = root / "alias"
            alias.symlink_to(target, target_is_directory=True)
            result = jev.decide(event(), settings(), evaluator=lambda *_: GOOD, storage=alias)
            self.assertEqual(result.reason, "storage_unavailable")
            self.assertEqual(list(target.iterdir()), [])

    def test_mcp_is_observed_until_separately_enabled(self):
        payload = event({"content": [{"type": "text", "text": PROGRESS}]}, tool="mcp__demo__logs")
        default = jev.decide(payload, settings(), evaluator=lambda *_: GOOD, simulate=True)
        allowed = jev.decide(payload, settings(allow_mcp_replacement=True), evaluator=lambda *_: GOOD, simulate=True)
        self.assertEqual(default.reason, "mcp_observe_only")
        self.assertEqual(allowed.status, "replace")


class ContractTests(unittest.TestCase):
    def test_hook_adapter_replace_contract_with_mock_jev(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "config.json").write_text(json.dumps({"enabled": True, "mode": "replace"}))
            configure_key.save_key(Path(directory), "synthetic-test-key")
            printed = io.StringIO()
            with (
                mock.patch.dict(os.environ, {"PLUGIN_DATA": directory}),
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
            self.assertEqual(jev.call_args.args[2], "synthetic-test-key")

    def test_type_safe_request_uses_three_nouls_and_choice_confidence(self):
        response = {"model": "jev-1.13.0", "answers": {
            **{key: {"type": "noul", "noul": GOOD[key]} for key in jev.SCORE_NAMES},
            "filter_decision": {"type": "choice", "choice": "filter", "confidence": .96,
                                "probabilities": {"filter": .98, "keep": .02}},
        }}
        fake = io.BytesIO(json.dumps(response).encode())
        with mock.patch.object(jev.request, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value = fake
            scores = jev.jev_request({"tool": "Bash", "output_sample": "text"}, settings(), "test-key")
        req = urlopen.call_args.args[0]
        self.assertEqual(req.full_url, jev.ENDPOINT)
        self.assertEqual(req.get_header("Authorization"), "Bearer test-key")
        sent = json.loads(req.data)
        self.assertEqual(set(sent["questions"]), set(jev.SCORE_NAMES) | {"filter_decision"})
        self.assertTrue(all(sent["questions"][name]["type"] == "noul" for name in jev.SCORE_NAMES))
        self.assertEqual(sent["questions"]["filter_decision"]["type"], "choice")
        self.assertEqual(scores, GOOD)

    def test_missing_choice_confidence_fails_closed(self):
        answers = {key: {"type": "noul", "noul": GOOD[key]} for key in jev.SCORE_NAMES}
        answers["filter_decision"] = {"type": "choice", "choice": "filter",
                                      "probabilities": {"filter": .98, "keep": .02}}
        with mock.patch.object(jev.request, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value = io.BytesIO(json.dumps({"answers": answers}).encode())
            with self.assertRaisesRegex(ValueError, "filter decision"):
                jev.jev_request({"output_sample": "text"}, settings(), "test-key")

    def test_oversized_jev_payload_is_rejected_before_http(self):
        with mock.patch.object(jev.request, "urlopen") as urlopen:
            with self.assertRaisesRegex(ValueError, "context budget"):
                jev.jev_request({"output_sample": "x" * 30_000}, settings(), "test-key")
        urlopen.assert_not_called()

    def test_private_env_file_is_read_without_shell_expansion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = configure_key.save_key(root, "synthetic-test-key")
            self.assertEqual(jev.load_api_key(root), "synthetic-test-key")
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            target.write_text("JEV_API_KEY='another-test-key'\nIGNORED=$(whoami)\n")
            self.assertEqual(jev.load_api_key(root), "another-test-key")
            target.write_text("JEV_API_KEY=too-short\nJEV_API_KEY=duplicate-value\n")
            with self.assertRaises(ValueError):
                jev.load_api_key(root)
            target.unlink()
            target.symlink_to(root / "other")
            with self.assertRaises(OSError):
                jev.load_api_key(root)

    def test_command_hook_disabled_without_plugin_data(self):
        hook = ROOT / "hooks" / "post_tool_use.py"
        env = {**os.environ}
        env.pop("PLUGIN_DATA", None)
        run = subprocess.run([sys.executable, str(hook)], input=json.dumps(event()), text=True, capture_output=True, env=env, check=True)
        self.assertEqual(run.stdout.strip(), "{}")
        self.assertEqual(run.stderr, "")

    def test_command_hook_missing_key_keeps_output_and_logs_metadata_only(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "config.json").write_text(json.dumps({"enabled": True, "mode": "observe"}))
            output = io.StringIO()
            with (
                mock.patch.dict(os.environ, {"PLUGIN_DATA": directory}, clear=False),
                mock.patch.object(sys, "stdin", io.StringIO(json.dumps(event()))),
                contextlib.redirect_stdout(output),
            ):
                post_tool_use.main()
            self.assertEqual(output.getvalue().strip(), "{}")
            log = Path(directory, "events.jsonl").read_text()
            self.assertIn("evaluator_unavailable", log)
            self.assertIn('"status":"calling"', log)
            self.assertNotIn("Compiling module", log)

    def test_command_hook_malformed_input_fails_open_without_log(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "config.json").write_text(json.dumps({"enabled": True}))
            output = io.StringIO()
            with (
                mock.patch.dict(os.environ, {"PLUGIN_DATA": directory}, clear=False),
                mock.patch.object(sys, "stdin", io.StringIO("{not json")),
                contextlib.redirect_stdout(output),
            ):
                post_tool_use.main()
            self.assertEqual(output.getvalue().strip(), "{}")
            self.assertFalse(Path(directory, "events.jsonl").exists())

    def test_command_hook_records_keep_when_jev_rejects_replacement(self):
        with tempfile.TemporaryDirectory() as directory:
            Path(directory, "config.json").write_text(json.dumps({"enabled": True, "mode": "replace"}))
            configure_key.save_key(Path(directory), "synthetic-test-key")
            output = io.StringIO()
            with (
                mock.patch.dict(os.environ, {"PLUGIN_DATA": directory}, clear=False),
                mock.patch.object(sys, "stdin", io.StringIO(json.dumps(event()))),
                mock.patch.object(post_tool_use, "jev_request", return_value=BAD),
                contextlib.redirect_stdout(output),
            ):
                post_tool_use.main()
            self.assertEqual(output.getvalue().strip(), "{}")
            records = [json.loads(line) for line in Path(directory, "events.jsonl").read_text().splitlines()]
            self.assertEqual([row["status"] for row in records], ["calling", "keep"])
            self.assertEqual(records[-1]["reason"], "jev_keep")
            self.assertFalse(list(Path(directory).rglob("*.txt")))


class ReplayTests(unittest.TestCase):
    def test_live_replay_uses_supplied_key(self):
        case = next(replay.generated_cases(1))
        with mock.patch.object(replay, "jev_request", return_value=GOOD) as request:
            report = replay.run([case], live=True, key="synthetic-test-key", mode="replace", config=jev.Config())
        self.assertEqual(report["simulated_replacements"], 1)
        self.assertEqual(request.call_args.args[2], "synthetic-test-key")

    def test_mock_benchmark_counts_context_only_for_replacements(self):
        with mock.patch.object(benchmark_context, "token_counter", return_value=("chars", len)):
            report = benchmark_context.benchmark(1)
        self.assertEqual(report["replaced"], 1)
        self.assertEqual(report["false_replacements_against_synthetic_labels"], 0)
        self.assertGreater(report["tokens_saved"], 0)
        self.assertEqual(report["per_category"]["failure"]["tokens_saved"], 0)

    def test_1000_case_offline_corpus_has_no_policy_false_replacements(self):
        report = replay.run(replay.generated_cases(100), live=False, mode="replace", config=jev.Config())
        self.assertEqual(report["kind"], "OFFLINE POLICY REPLAY (mock Jev scores)")
        self.assertEqual(report["cases"], 1000)
        self.assertEqual(report["false_replacements"], 0)
        self.assertEqual(report["missed_replacements"], 0)
        self.assertEqual(report["simulated_replacements"], 100)


if __name__ == "__main__":
    unittest.main()
