import json
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
import evaluate_quality as quality  # noqa: E402


GOOD = {"routine_noise": .99, "needs_exact_text": .01, "one_off_value": .01,
        "filter_approved": True, "filter_confidence": .99}


class QualityEvaluationTests(unittest.TestCase):
    def test_labeled_evidence_and_paired_outcomes_are_reported(self):
        cases = [{"route": "output", "original": "a crucial fact z", "visible": "a z",
                  "required": ["crucial fact"], "safe_to_shorten": False,
                  "scores": GOOD, "baseline_task_success": True, "filtered_task_success": False}]
        report = quality.summarize(cases)["output"]
        self.assertEqual(report["unsafe_gate_decisions"], 1)
        self.assertEqual(report["visible_results_missing_required_evidence"], 1)
        self.assertEqual(report["baseline_tasks_solved"], 1)
        self.assertEqual(report["filtered_tasks_solved"], 0)

    def test_invalid_labels_are_rejected_and_small_cohort_cannot_calibrate(self):
        with tempfile.TemporaryDirectory(prefix="jev-quality-", dir="/tmp") as directory:
            path = Path(directory) / "cases.jsonl"
            path.write_text(json.dumps({"route": "output", "original": "abc", "visible": "a",
                                        "required": ["missing"], "safe_to_shorten": True}) + "\n")
            with self.assertRaises(ValueError):
                quality.load_cases(path)
        self.assertIsNone(quality.recommend([{"route": "output", "scores": GOOD,
                                            "safe_to_shorten": True}], "output"))

    def test_calibration_requires_held_out_risk_bound(self):
        cases = [{"route": "output", "scores": GOOD, "safe_to_shorten": True}
                 for _ in range(1800)]
        recommended = quality.recommend(cases, "output")
        self.assertEqual(recommended["thresholds"], quality.DEFAULT_THRESHOLDS["output"])
        self.assertEqual(recommended["held_out_errors"], 0)
        cases[0]["safe_to_shorten"] = False
        self.assertIsNone(quality.recommend(cases, "output"))


if __name__ == "__main__":
    unittest.main()
