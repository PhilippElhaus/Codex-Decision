"""Evidence preservation and structured-output edge cases."""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "hooks"))
import jev  # noqa: E402
import search_listing  # noqa: E402
import test_build  # noqa: E402


GOOD = {"routine_noise": .99, "needs_exact_text": .01, "one_off_value": .01,
        "filter_approved": True, "filter_confidence": .99}


def event(command, output):
    return {"session_id": "evidence", "tool_use_id": "call-1", "hook_event_name": "PostToolUse",
            "tool_name": "Bash", "tool_input": {"command": command}, "tool_response": output}


class OutputEvidenceTests(unittest.TestCase):
    def test_medium_output_is_judged_in_full_and_capsule_keeps_middle_result(self):
        lines = [f"Compiling module {i:04d} ... done\n" for i in range(390)]
        lines[190] = "Result: migration count 8127\n"
        output = "".join(lines)
        seen = []
        result = jev.decide(event("build", output), jev.Config(enabled=True),
                            lambda state, _: seen.append(state["output_sample"]) or GOOD, simulate=True)
        self.assertEqual(seen, [output])
        self.assertEqual(result.status, "replace")
        self.assertIn("Result: migration count 8127", result.hook_output["reason"])
        self.assertIn("Omitted original lines:", result.hook_output["reason"])

    def test_unlisted_numeric_values_are_not_normalized_as_progress(self):
        output = "".join(f"receipt id: {i:04d}\n" for i in range(400))
        self.assertEqual(jev.repetitive_fraction(output), 0)

    def test_chunk_boundaries_preserve_lines_and_all_text(self):
        output = "".join(f"Processing item {i:05d}\n" for i in range(2000))
        chunks = jev._output_chunks(output)
        self.assertEqual("".join(chunks), output)
        self.assertTrue(all(piece.endswith("\n") for piece in chunks))
        self.assertTrue(all(len(json.dumps(piece, ensure_ascii=False).encode()) <= jev.CHUNK_JSON_BYTES
                            for piece in chunks))

    def test_chunk_veto_stops_later_waves(self):
        output = "".join(f"Processing item {i:05d}\n" for i in range(18000))
        calls = []
        def evaluator(state, _):
            calls.append(state["chunk_index"])
            return {**GOOD, "filter_approved": False} if state["chunk_index"] == 1 else GOOD
        result = jev.decide(event("build", output), jev.Config(enabled=True), evaluator,
                            simulate=True)
        self.assertEqual(result.reason, "jev_keep")
        self.assertLessEqual(len(calls), jev.CHUNK_WORKERS)

    def test_long_selected_line_is_marked_as_truncated(self):
        text = "Result: " + "Z" * 3000
        output = "".join(f"Processing item {i:04d}\n" for i in range(400)) + text + "\n"
        result = jev.decide(event("build", output), jev.Config(enabled=True),
                            lambda *_: GOOD, simulate=True)
        self.assertEqual(result.status, "replace")
        self.assertIn("[line truncated]", result.hook_output["reason"])
        self.assertIn("Truncated selected lines:", result.hook_output["reason"])


class SearchEvidenceTests(unittest.TestCase):
    def test_task_specific_hit_displaces_generic_representative(self):
        lines = [f"src/component_{i}.py:{i + 1}:ordinary item\n" for i in range(80)]
        lines[31] = "src/auth.py:32:verify_refresh_token\n"
        self.assertIn(lines[31], search_listing._representatives(lines, "verify_refresh_token"))

    def test_task_ranking_keeps_leads_from_distinct_files(self):
        lines = [f"src/general.py:{i + 1}:routine call\n" for i in range(100)]
        lines[22] = "src/auth.py:23:refresh_token handler\n"
        lines[73] = "src/auth_test.py:74:refresh_token regression\n"
        chosen = search_listing._representatives(lines, "refresh_token")
        self.assertIn(lines[22], chosen)
        self.assertIn(lines[73], chosen)

    def test_rg_json_preserves_colon_path_and_match_location(self):
        records = []
        for folder in ("src:module", "docs/archive"):
            for i in range(65):
                records.append({"type": "match", "data": {"path": {"text": f"{folder}/file.py"},
                                "line_number": i + 1, "lines": {"text": f"found value {i}\n"}}})
        records.append({"type": "summary", "data": {"stats": {}}})
        output = "".join(json.dumps(row) + "\n" for row in records)
        decisions = lambda state, questions, _: {
            name: {"type": "choice", "choice": "summarize", "confidence": .99,
                   "probabilities": {"retain": .01, "summarize": .98, "drop": .01}}
            for name in questions}
        result = search_listing.decide_search_listing(
            event("rg --json found .", output), jev.Config(search_listing_enabled=True),
            decisions, simulate=True)
        self.assertEqual(result.status, "replace")
        self.assertIn("src:module/file.py:1:found value 0", result.hook_output["reason"])
        self.assertIn("full JSON", result.hook_output["reason"])

    def test_malformed_rg_json_fails_closed(self):
        output = ('{"type":"match","data":{"path":{"text":"a.py"}}}\n' * 100)
        result = search_listing.decide_search_listing(
            event("rg --json found .", output), jev.Config(search_listing_enabled=True),
            lambda *_: self.fail("Jev should not be called"), simulate=True)
        self.assertEqual(result.reason, "unstructured")

    @unittest.skipUnless(shutil.which("rg"), "ripgrep is not installed")
    def test_real_rg_json_stream_is_accepted(self):
        with tempfile.TemporaryDirectory(prefix="jev-rg-json-", dir="/tmp") as directory:
            root = Path(directory)
            for folder in ("src", "docs"):
                path = root / folder
                path.mkdir()
                (path / "file.txt").write_text("".join(f"found value {i}\n" for i in range(90)))
            output = subprocess.run(["rg", "--json", "-n", "found", "."], cwd=root,
                                    text=True, capture_output=True, check=True).stdout
        answers = lambda state, questions, _: {
            name: {"type": "choice", "choice": "summarize", "confidence": .99,
                   "probabilities": {"retain": .01, "summarize": .98, "drop": .01}}
            for name in questions}
        result = search_listing.decide_search_listing(
            event("rg --json -n found .", output), jev.Config(search_listing_enabled=True),
            answers, simulate=True)
        self.assertEqual(result.status, "replace")
        self.assertIn("found value", result.hook_output["reason"])


class StructuredBuildTests(unittest.TestCase):
    def test_go_json_retains_failure_and_package_result(self):
        records = ([{"Action": "pass", "Package": "p", "Test": f"Test{i}"} for i in range(100)]
                   + [{"Action": "fail", "Package": "p", "Test": "TestImportant",
                       "Output": "assertion mismatch"}, {"Action": "fail", "Package": "p"}])
        output = "".join(json.dumps(row) + "\n" for row in records)
        result = test_build.decide_test_build(
            event("go test -json ./...", output), jev.Config(test_build_enabled=True),
            lambda *_: GOOD, simulate=True)
        self.assertEqual(result.status, "replace")
        self.assertIn("assertion mismatch", result.hook_output["reason"])
        self.assertIn('"Action": "fail", "Package": "p"', result.hook_output["reason"])

    def test_cargo_json_retains_diagnostic_and_completion(self):
        records = ([{"reason": "compiler-artifact", "target": f"crate_{i}"} for i in range(100)]
                   + [{"reason": "compiler-message", "message": {"level": "warning", "message": "unused item"}},
                      {"reason": "build-finished", "success": True}])
        output = "".join(json.dumps(row) + "\n" for row in records)
        result = test_build.decide_test_build(
            event("cargo build --message-format=json", output), jev.Config(test_build_enabled=True),
            lambda *_: GOOD, simulate=True)
        self.assertEqual(result.status, "replace")
        self.assertIn("unused item", result.hook_output["reason"])
        self.assertIn('"success": true', result.hook_output["reason"])

    def test_json_events_with_potentially_useful_payload_stay_visible(self):
        go_lines = [json.dumps({"Action": "output", "Output": "--- PASS: TestA (0.1s)\nunique value 91\n"}) + "\n"]
        go_lines.extend(json.dumps({"Action": "pass", "Test": f"Test{i}"}) + "\n" for i in range(80))
        go_lines.append(json.dumps({"Action": "pass", "Package": "p"}) + "\n")
        omitted, retained, complete = test_build._structured_partition(go_lines, "go test -json")
        self.assertTrue(complete)
        self.assertIn("unique value 91", "".join(retained))
        self.assertEqual(len(omitted), 80)

        cargo_lines = [json.dumps({"reason": "compiler-artifact", "executable": "/build/app"}) + "\n",
                       json.dumps({"reason": "build-finished", "success": True}) + "\n"]
        omitted, retained, complete = test_build._structured_partition(
            cargo_lines, "cargo build --message-format=json")
        self.assertTrue(complete)
        self.assertEqual(omitted, [])
        self.assertIn("/build/app", "".join(retained))


if __name__ == "__main__":
    unittest.main()
