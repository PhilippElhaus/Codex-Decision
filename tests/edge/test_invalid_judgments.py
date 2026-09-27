"""Bad Jev answers must leave the original output available."""

import math
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "hooks"))
import jev  # noqa: E402
import test_build  # noqa: E402
from tests.e2e.test_filter_e2e import event, output_fixture, test_fixture  # noqa: E402


GOOD = {"routine_noise": .98, "needs_exact_text": .01, "one_off_value": .01,
        "filter_approved": True, "filter_confidence": .96}


class InvalidJudgmentTests(unittest.TestCase):
    def test_output_and_test_build_keep_invalid_answers_without_writing_original(self):
        routes = (
            ("output", jev.decide, event("echo progress", output_fixture(), "bad-output"),
             jev.Config(enabled=True)),
            ("test/build", test_build.decide_test_build,
             event("python3 -m unittest discover -v", test_fixture(), "bad-test"),
             jev.Config(test_build_enabled=True)),
        )
        bad_answers = (
            {**GOOD, "routine_noise": math.nan},
            {**GOOD, "needs_exact_text": True},
            {**GOOD, "filter_confidence": 1.01},
            {name: value for name, value in GOOD.items() if name != "filter_approved"},
        )
        with tempfile.TemporaryDirectory(prefix="jev-invalid-answer-", dir="/tmp") as directory:
            storage = Path(directory)
            for route, decide, payload, config in routes:
                for answer in bad_answers:
                    with self.subTest(route=route, answer=answer):
                        result = decide(payload, config, evaluator=lambda *_: answer, storage=storage)
                        self.assertEqual((result.status, result.reason), ("keep", "evaluator_unavailable"))
                        self.assertIsNone(result.hook_output)
                        self.assertFalse((storage / "outputs").exists())


if __name__ == "__main__":
    unittest.main()
