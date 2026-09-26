"""Validate benchmark accounting and a process-level three-route replay."""

import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import benchmark_all_filters as bench  # noqa: E402
from test_filter_e2e import MOCK_BRIDGE  # noqa: E402


class BenchmarkTests(unittest.TestCase):
    def test_percentiles_and_reduction_handle_empty_and_small_samples(self):
        self.assertEqual(bench.percentiles([]), {"p50": 0, "p95": 0, "max": 0})
        self.assertEqual(bench.percentiles([1, 2, 3]), {"p50": 2, "p95": 3, "max": 3})
        self.assertEqual(bench.reduction_percent([]), 0)
        self.assertEqual(bench.reduction_percent([
            {"original_tokens": 100, "visible_tokens": 25},
            {"original_tokens": 100, "visible_tokens": 75},
        ]), 50)

    def test_mock_matrix_covers_every_route_and_preserves_required_evidence(self):
        with mock.patch.object(bench, "token_counter", return_value=("characters", len)):
            report = bench.run_mock(3)
        self.assertEqual(report["cases"], 67)
        self.assertEqual(report["jev_calls"], 33)
        self.assertEqual(report["synthetic_label_mismatches"], 0)
        self.assertEqual(set(report["by_route"]), {"output", "test_build", "search_listing"})
        self.assertEqual(sum(route["tokens_saved"] for route in report["by_route"].values()),
                         report["tokens_saved"])
        self.assertGreater(report["within_limit_reduction_percent"],
                           report["all_result_reduction_percent"])
        self.assertTrue(all(route["replaced"] > 0 and route["skipped"] > 0
                            for route in report["by_route"].values()))
        self.assertEqual(report["categories"]["search_listing/too_many_groups"], 1)
        self.assertEqual(report["categories"]["test_build/failing_tests"], 3)

    def test_real_fixture_capture_runs_tools_and_has_all_three_routes(self):
        with tempfile.TemporaryDirectory(prefix="jev-benchmark-fixtures-", dir="/tmp") as directory:
            cases = bench.live_cases(Path(directory))
        self.assertEqual(len(cases), 10)
        self.assertEqual({item["route"] for item in cases}, {"output", "test_build", "search_listing"})
        by_name = {item["category"]: item for item in cases}
        self.assertIn("AssertionError: 1 != 2", by_name["real_failing_suite"]["output"])
        self.assertIn("BUILD SUCCESSFUL", by_name["real_c_build"]["output"])
        self.assertEqual(len(by_name["real_file_listing"]["output"].splitlines()), 350)
        self.assertEqual(len(by_name["real_search_hits"]["output"].splitlines()), 350)

    def test_real_command_hook_with_process_mock_and_oversized_edges(self):
        with tempfile.TemporaryDirectory(prefix="jev-benchmark-bridge-", dir="/tmp") as directory:
            binary = Path(directory) / "bin"
            binary.mkdir()
            bridge = binary / "pwsh.exe"
            bridge.write_text(MOCK_BRIDGE)
            bridge.chmod(0o700)
            calls = Path(directory) / "calls.jsonl"
            with (mock.patch.dict(os.environ, {
                    "PATH": str(binary) + os.pathsep + os.environ["PATH"],
                    "JEV_MOCK_CALLS": str(calls),
                }), mock.patch.object(bench, "token_counter", return_value=("characters", len))):
                report = bench.run_live(rounds=1)
            self.assertEqual(report["cases"], 16)
            self.assertEqual(report["real_command_fixtures"], 10)
            self.assertEqual(report["jev_calls"], len(calls.read_text().splitlines()))
            self.assertEqual(report["by_fixture"]["oversize"]["jev_calls"], 0)
            self.assertEqual(report["by_fixture"]["oversize"]["skipped"], 3)
            self.assertGreater(report["tokens_saved"], 0)
            self.assertGreater(report["by_route"]["test_build"]["replaced"], 0)


if __name__ == "__main__":
    unittest.main()
