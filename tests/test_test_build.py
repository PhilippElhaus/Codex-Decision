import contextlib
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "hooks"))
import jev  # noqa: E402
import post_tool_use  # noqa: E402
import test_build  # noqa: E402

GOOD = {"routine_noise": 0.98, "needs_exact_text": 0.02, "one_off_value": 0.01,
        "filter_approved": True, "filter_confidence": 0.96}


def hook_event(command, output, call="test-build-call"):
    return {
        "session_id": "test-build-session", "turn_id": "test-build-turn", "tool_use_id": call,
        "hook_event_name": "PostToolUse", "tool_name": "Bash",
        "tool_input": {"command": command}, "tool_response": output,
    }


def unittest_log(count=80, failed=False):
    passes = "".join(
        f"test_case_{n:03d} (suite.Tests.test_case_{n:03d}) ... ok\n" for n in range(count)
    )
    failure = (
        "test_critical (suite.Tests.test_critical) ... FAIL\n"
        "======================================================================\n"
        "FAIL: test_critical (suite.Tests.test_critical)\n"
        "Traceback (most recent call last):\n"
        "  File \"tests/test_critical.py\", line 42, in test_critical\n"
        "    self.assertEqual(actual, expected)\n"
        "AssertionError: 2 != 3\n"
    ) if failed else ""
    end = f"Ran {count + int(failed)} tests in 3.211s\n\n" + (
        "FAILED (failures=1)\n" if failed else "OK\n"
    )
    return "Starting suite\n" + passes + failure + end


class CommandTests(unittest.TestCase):
    def test_allowlisted_commands_and_compound_command_rejection(self):
        allowed = {
            "python3 -m unittest discover -v": "test",
            "python -m pytest -v": "test",
            "pytest tests -v": "test",
            "node --test tests/*.test.cjs": "test",
            "npm --prefix vscode-control test": "test",
            "pnpm run build": "build",
            "cargo test --workspace": "test",
            "cargo build --release": "build",
            "go test ./...": "test",
            "dotnet build": "build",
            "./gradlew test": "test",
            "mvn package": "build",
            "cmake --build build": "build",
        }
        for command, kind in allowed.items():
            with self.subTest(command=command):
                self.assertEqual(test_build.command_kind({"command": command}), kind)
        for command in (
            "npm install && npm test", "pytest; cat /etc/passwd", "cat tests.py",
            "npm --prefix test install", "pytest | tail", "pytest $(echo tests)",
            "python -m unittest\ncat file", "npm test > output.txt",
        ):
            with self.subTest(command=command):
                self.assertIsNone(test_build.command_kind({"command": command}))


class ReductionTests(unittest.TestCase):
    def settings(self, **changes):
        return jev.Config(test_build_enabled=True, **changes)

    def test_threshold_can_keep_ambiguous_routine_lines(self):
        scores = {**GOOD, "routine_noise": .93, "needs_exact_text": .12, "one_off_value": .09}
        self.assertTrue(test_build.jev_approves_omission(scores))
        strict = self.settings(thresholds={"test_build": {"routine_min": 96}})
        self.assertFalse(test_build.jev_approves_omission(scores, strict))
        self.assertFalse(test_build.jev_approves_omission({**scores, "filter_confidence": .69}))
        self.assertFalse(test_build.jev_approves_omission({**scores, "filter_approved": False}))

    def decide(self, event, config, storage=None, evaluator=lambda *_: GOOD):
        return test_build.decide_test_build(event, config, evaluator=evaluator, storage=storage)

    def test_success_saves_exact_original_and_keeps_completion(self):
        output = unittest_log()
        with tempfile.TemporaryDirectory(prefix="jev-test-build-", dir="/tmp") as directory:
            root = Path(directory)
            result = self.decide(hook_event("python3 -m unittest discover -v", output), self.settings(), root)
            self.assertEqual(result.status, "replace")
            feedback = result.hook_output["reason"]
            self.assertIn("80 routine lines omitted", feedback)
            self.assertIn("Ran 80 tests in 3.211s", feedback)
            self.assertIn("\nOK\n", feedback)
            self.assertNotIn("test_case_010", feedback)
            originals = list(root.rglob("*.txt"))
            self.assertEqual(len(originals), 1)
            self.assertEqual(originals[0].read_text(), output)
            self.assertEqual(stat.S_IMODE(originals[0].stat().st_mode), 0o600)
            self.assertLess(result.capsule_chars, result.original_chars * 0.7)

    def test_failure_diagnostics_and_exit_text_are_retained(self):
        output = unittest_log(failed=True) + "Process exited with code 1\n"
        with tempfile.TemporaryDirectory(prefix="jev-test-build-", dir="/tmp") as directory:
            result = self.decide(hook_event("python3 -m unittest discover -v", output), self.settings(), Path(directory))
            self.assertEqual(result.status, "replace")
            for important in (
                "test_critical (suite.Tests.test_critical) ... FAIL",
                "Traceback (most recent call last):", "AssertionError: 2 != 3",
                "FAILED (failures=1)", "Process exited with code 1",
            ):
                self.assertIn(important, result.hook_output["reason"])

    def test_node_and_build_logs_reduce_only_known_routine_lines(self):
        node = "\n".join(f"✔ test {n} passes ({n % 7 + 1}ms)" for n in range(120)) + "\nℹ tests 120\nℹ pass 120\nℹ fail 0\n"
        build = "\n".join(f"Compiling dependency-{n:03d} v1.2.3" for n in range(100)) + "\nwarning: useful warning stays\nFinished dev profile [unoptimized] target(s) in 4.10s\n"
        go = "\n".join(f"--- PASS: TestCase{n:03d} (0.00s)" for n in range(100)) + "\nPASS\nok  example.org/demo  0.103s\n"
        for command, output, retained in (
            ("node --test", node, "ℹ pass 120"),
            ("cargo build", build, "warning: useful warning stays"),
            ("go test -v ./...", go, "ok  example.org/demo  0.103s"),
        ):
            with self.subTest(command=command), tempfile.TemporaryDirectory(prefix="jev-test-build-", dir="/tmp") as directory:
                result = self.decide(hook_event(command, output), self.settings(), Path(directory))
                self.assertEqual(result.status, "replace")
                self.assertIn(retained, result.hook_output["reason"])
                self.assertEqual(next(Path(directory).rglob("*.txt")).read_text(), output)

    def test_observe_and_safety_gates_leave_original_untouched(self):
        output = unittest_log()
        cases = [
            ("pytest tests -v", output, self.settings(mode="observe"), "candidate"),
            ("pytest tests -v", output + "api_key = hidden\n", self.settings(), "skip"),
            ("pytest tests -v", output.replace("Ran 80 tests in 3.211s", "No final summary").replace("\nOK\n", "\nDone\n"), self.settings(), "skip"),
            ("pytest tests -v", "tiny", self.settings(), "skip"),
            ("cat test.log", output, self.settings(), "skip"),
            ("pytest tests -v", output, jev.Config(), "skip"),
        ]
        for command, text, config, status in cases:
            with self.subTest(command=command, status=status), tempfile.TemporaryDirectory(prefix="jev-test-build-", dir="/tmp") as directory:
                result = self.decide(hook_event(command, text), config, Path(directory))
                self.assertEqual(result.status, status)
                self.assertIsNone(result.hook_output)
                self.assertEqual(list(Path(directory).rglob("*.txt")), [])

    def test_missing_storage_duplicate_id_and_linked_storage_fail_open(self):
        output = unittest_log()
        event = hook_event("python3 -m unittest discover -v", output)
        self.assertEqual(self.decide(event, self.settings()).reason, "storage_unavailable")
        with tempfile.TemporaryDirectory(prefix="jev-test-build-", dir="/tmp") as directory:
            root = Path(directory)
            self.assertEqual(self.decide(event, self.settings(), root).status, "replace")
            self.assertEqual(self.decide(event, self.settings(), root).reason, "storage_unavailable")
            linked = root / "linked"
            linked.symlink_to(root, target_is_directory=True)
            self.assertEqual(self.decide({**event, "tool_use_id": "another"}, self.settings(), linked).reason, "storage_unavailable")
            self.assertEqual(self.decide({**event, "tool_use_id": "../escape"}, self.settings(), root).reason, "storage_unavailable")

    def test_jev_judgment_is_required_and_failure_keeps_full_output(self):
        event = hook_event("python3 -m unittest discover -v", unittest_log())
        with tempfile.TemporaryDirectory(prefix="jev-test-build-", dir="/tmp") as directory:
            root = Path(directory)
            self.assertEqual(test_build.decide_test_build(event, self.settings(), storage=root).reason, "no_evaluator")
            self.assertEqual(self.decide(event, self.settings(), root, evaluator=lambda *_: {
                **GOOD, "needs_exact_text": 0.85,
            }).reason, "jev_keep")
            self.assertEqual(self.decide(event, self.settings(), root, evaluator=lambda *_: (_ for _ in ()).throw(RuntimeError())).reason,
                             "evaluator_unavailable")
            self.assertEqual(list(root.rglob("*.txt")), [])

    def test_test_build_thresholds_account_for_whitelisted_pass_lines(self):
        self.assertTrue(test_build.jev_approves_omission({
            **GOOD, "routine_noise": 0.97, "needs_exact_text": 0.09, "one_off_value": 0.15,
        }))
        self.assertFalse(test_build.jev_approves_omission({
            **GOOD, "routine_noise": 0.97, "needs_exact_text": 0.21, "one_off_value": 0.15,
        }))
        self.assertFalse(test_build.jev_approves_omission({
            **GOOD, "routine_noise": 0.97, "needs_exact_text": 0.09, "one_off_value": 0.21,
        }))

    def test_jev_receives_only_bounded_candidate_and_retained_samples(self):
        event = hook_event("python3 -m unittest discover -v", unittest_log(failed=True))
        seen = []
        with tempfile.TemporaryDirectory(prefix="jev-test-build-", dir="/tmp") as directory:
            result = self.decide(event, self.settings(), Path(directory), evaluator=lambda state, _: (seen.append(state), GOOD)[1])
            self.assertEqual(result.status, "replace")
            self.assertEqual(result.scores, GOOD)
            self.assertIn("test_case_000", seen[0]["omitted_sample"])
            self.assertNotIn("AssertionError", seen[0]["omitted_sample"])
            self.assertIn("AssertionError", seen[0]["retained_sample"])
            self.assertLessEqual(len(seen[0]["omitted_sample"]), 6100)
            self.assertLessEqual(len(seen[0]["retained_sample"]), 4100)


class AdapterTests(unittest.TestCase):
    def test_selection_changes_apply_to_next_hook_call_in_same_session(self):
        output = unittest_log()
        progress = "\n".join(f"Compiling module {number:03d} done" for number in range(400))
        with tempfile.TemporaryDirectory(prefix="jev-live-toggle-", dir="/tmp") as directory:
            root = Path(directory)
            (root / ".env").write_text("JEV_API_KEY=synthetic-test-key\n")
            (root / ".env").chmod(0o600)
            config_path = root / "config.json"
            requests = []

            def call(name, command, text):
                printed = io.StringIO()
                payload = hook_event(command, text, call=name)
                with (
                    mock.patch.dict(os.environ, {"PLUGIN_DATA": directory}),
                    mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))),
                    mock.patch.object(post_tool_use, "jev_request", side_effect=lambda *_: requests.append("output") or GOOD),
                    mock.patch.object(post_tool_use, "jev_test_build_request", side_effect=lambda *_: requests.append("test_build") or GOOD),
                    contextlib.redirect_stdout(printed),
                ):
                    post_tool_use.main()
                return json.loads(printed.getvalue())

            config_path.write_text(json.dumps({"enabled": False, "test_build_enabled": False, "mode": "replace"}))
            self.assertEqual(call("off-1", "python3 -m unittest discover -v", output), {})
            self.assertEqual(requests, [])

            config_path.write_text(json.dumps({"enabled": False, "test_build_enabled": True, "mode": "replace"}))
            self.assertIs(call("test-on", "python3 -m unittest discover -v", output)["continue"], False)
            self.assertEqual(requests, ["test_build"])

            config_path.write_text(json.dumps({"enabled": True, "test_build_enabled": False, "mode": "replace"}))
            self.assertIs(call("output-on", "echo progress", progress)["continue"], False)
            self.assertEqual(requests, ["test_build", "output"])

            config_path.write_text(json.dumps({"enabled": False, "test_build_enabled": False, "mode": "replace"}))
            self.assertEqual(call("off-2", "echo progress", progress), {})
            self.assertEqual(requests, ["test_build", "output"])
            records = [json.loads(line) for line in (root / "events.jsonl").read_text().splitlines()]
            self.assertEqual([(row["filter"], row["status"]) for row in records], [
                ("test_build", "calling"), ("test_build", "replace"),
                ("output", "calling"), ("output", "replace"),
            ])

    def test_test_build_request_uses_jev_nouls_and_bounded_state(self):
        response = {"model": "jev-1.13.0", "answers": {
            **{key: {"type": "noul", "noul": GOOD[key]} for key in jev.SCORE_NAMES},
            "filter_decision": {"type": "choice", "choice": "filter", "confidence": .96,
                                "probabilities": {"filter": .98, "keep": .02}},
        }}
        fake = io.BytesIO(json.dumps(response).encode())
        state = {"kind": "test", "omitted_sample": "test_a ... ok", "retained_sample": "Ran 1 test\nOK"}
        with mock.patch.object(jev.request, "urlopen") as urlopen:
            urlopen.return_value.__enter__.return_value = fake
            scores = jev.jev_test_build_request(state, jev.Config(), "test-key")
        self.assertEqual(scores, GOOD)
        payload = json.loads(urlopen.call_args.args[0].data)
        self.assertEqual(payload["state"], state)
        self.assertEqual(set(payload["questions"]), set(jev.SCORE_NAMES) | {"filter_decision"})
        self.assertTrue(all("omitted_sample" in question["instructions"] for question in payload["questions"].values()))

    def test_test_build_filter_calls_jev_and_logs_scores(self):
        with tempfile.TemporaryDirectory(prefix="jev-test-build-", dir="/tmp") as directory:
            root = Path(directory)
            (root / ".env").write_text("JEV_API_KEY=synthetic-test-key\n")
            (root / ".env").chmod(0o600)
            (root / "config.json").write_text('{"enabled":true,"test_build_enabled":true,"search_listing_enabled":true,"mode":"replace"}')
            payload = hook_event("python3 -m unittest discover -v", unittest_log())
            printed = io.StringIO()
            with (
                mock.patch.dict(os.environ, {"PLUGIN_DATA": directory}),
                mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))),
                mock.patch.object(post_tool_use, "jev_request", side_effect=AssertionError("wrong Jev workflow")),
                mock.patch.object(post_tool_use, "jev_choice_request", side_effect=AssertionError("wrong Jev workflow")),
                mock.patch.object(post_tool_use, "jev_test_build_request", return_value=GOOD) as request,
                contextlib.redirect_stdout(printed),
            ):
                post_tool_use.main()
            response = json.loads(printed.getvalue())
            self.assertIs(response["continue"], False)
            records = [json.loads(line) for line in (root / "events.jsonl").read_text().splitlines()]
            self.assertEqual([(row["filter"], row["status"]) for row in records],
                             [("test_build", "calling"), ("test_build", "replace")])
            self.assertEqual(records[-1]["scores"], GOOD)
            self.assertNotIn("test_case_", json.dumps(records))
            request.assert_called_once()

    def test_test_build_jev_outage_keeps_full_result(self):
        with tempfile.TemporaryDirectory(prefix="jev-test-build-", dir="/tmp") as directory:
            root = Path(directory)
            (root / ".env").write_text("JEV_API_KEY=synthetic-test-key\n")
            (root / ".env").chmod(0o600)
            (root / "config.json").write_text('{"enabled":false,"test_build_enabled":true}')
            printed = io.StringIO()
            with (
                mock.patch.dict(os.environ, {"PLUGIN_DATA": directory}),
                mock.patch.object(sys, "stdin", io.StringIO(json.dumps(hook_event("python3 -m unittest discover -v", unittest_log())))),
                mock.patch.object(post_tool_use, "jev_test_build_request", side_effect=RuntimeError("offline")) as request,
                contextlib.redirect_stdout(printed),
            ):
                post_tool_use.main()
            self.assertEqual(json.loads(printed.getvalue()), {})
            self.assertEqual([json.loads(line)["status"] for line in (root / "events.jsonl").read_text().splitlines()],
                             ["calling", "keep"])
            self.assertEqual(list(root.rglob("*.txt")), [])
            request.assert_called_once()

    def test_local_only_selection_ignores_unrelated_commands(self):
        with tempfile.TemporaryDirectory(prefix="jev-test-build-", dir="/tmp") as directory:
            root = Path(directory)
            (root / "config.json").write_text('{"enabled":false,"test_build_enabled":true}')
            printed = io.StringIO()
            with (
                mock.patch.dict(os.environ, {"PLUGIN_DATA": directory}),
                mock.patch.object(sys, "stdin", io.StringIO(json.dumps(hook_event("git status", unittest_log())))),
                contextlib.redirect_stdout(printed),
            ):
                post_tool_use.main()
            self.assertEqual(json.loads(printed.getvalue()), {})
            self.assertFalse((root / "events.jsonl").exists())

    def test_unrecognized_command_still_uses_jev_when_both_selected(self):
        with tempfile.TemporaryDirectory(prefix="jev-test-build-", dir="/tmp") as directory:
            root = Path(directory)
            (root / ".env").write_text("JEV_API_KEY=synthetic-test-key\n")
            (root / ".env").chmod(0o600)
            (root / "config.json").write_text('{"enabled":true,"test_build_enabled":true}')
            payload = hook_event("git status", "Compiling module 1\n" * 900)
            printed = io.StringIO()
            scores = {**GOOD, "routine_noise": 0.99, "needs_exact_text": 0.01, "one_off_value": 0.01}
            with (
                mock.patch.dict(os.environ, {"PLUGIN_DATA": directory}),
                mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))),
                mock.patch.object(post_tool_use, "jev_request", return_value=scores) as request,
                contextlib.redirect_stdout(printed),
            ):
                post_tool_use.main()
            self.assertIs(json.loads(printed.getvalue())["continue"], False)
            self.assertEqual([json.loads(line)["filter"] for line in (root / "events.jsonl").read_text().splitlines()],
                             ["output", "output"])
            request.assert_called_once()

    def test_non_bash_tool_with_test_command_is_not_routed_to_local_filter(self):
        with tempfile.TemporaryDirectory(prefix="jev-test-build-", dir="/tmp") as directory:
            root = Path(directory)
            (root / "config.json").write_text('{"enabled":false,"test_build_enabled":true}')
            payload = {**hook_event("pytest tests -v", unittest_log()), "tool_name": "mcp__demo__logs"}
            printed = io.StringIO()
            with (
                mock.patch.dict(os.environ, {"PLUGIN_DATA": directory}),
                mock.patch.object(sys, "stdin", io.StringIO(json.dumps(payload))),
                contextlib.redirect_stdout(printed),
            ):
                post_tool_use.main()
            self.assertEqual(json.loads(printed.getvalue()), {})
            self.assertFalse((root / "events.jsonl").exists())


if __name__ == "__main__":
    unittest.main()
