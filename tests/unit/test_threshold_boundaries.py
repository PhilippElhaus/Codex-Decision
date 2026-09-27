"""Exercise inclusive cutoffs and the first value outside each cutoff."""

from pathlib import Path
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "hooks"))
import jev  # noqa: E402
import search_listing  # noqa: E402
import test_build  # noqa: E402


class ThresholdBoundaryTests(unittest.TestCase):
    def test_output_filter_accepts_exact_cutoffs(self):
        at_cutoff = {"routine_noise": .90, "needs_exact_text": .12, "one_off_value": .10,
                     "filter_approved": True, "filter_confidence": .70}
        self.assertTrue(jev.candidate(at_cutoff))
        for name, outside in (("routine_noise", .8999), ("needs_exact_text", .1201),
                              ("one_off_value", .1001), ("filter_confidence", .6999),
                              ("filter_approved", False)):
            with self.subTest(signal=name):
                self.assertFalse(jev.candidate({**at_cutoff, name: outside}))

    def test_test_build_filter_accepts_exact_cutoffs(self):
        at_cutoff = {"routine_noise": .90, "needs_exact_text": .20, "one_off_value": .20,
                     "filter_approved": True, "filter_confidence": .70}
        self.assertTrue(test_build.jev_approves_omission(at_cutoff))
        for name, outside in (("routine_noise", .8999), ("needs_exact_text", .2001),
                              ("one_off_value", .2001), ("filter_confidence", .6999),
                              ("filter_approved", False)):
            with self.subTest(signal=name):
                self.assertFalse(test_build.jev_approves_omission({**at_cutoff, name: outside}))

    def test_search_summarize_and_drop_cutoffs(self):
        def choice(value, confidence, name):
            remainder = (1 - value) / 2
            return {"type": "choice", "choice": name, "confidence": confidence,
                    "probabilities": {name: value, **{other: remainder
                        for other in {"retain", "summarize", "drop"} - {name}}}}

        self.assertEqual(search_listing._decision(choice(.78, .70, "summarize")), "summarize")
        self.assertEqual(search_listing._decision(choice(.779, .70, "summarize")), "retain")
        self.assertEqual(search_listing._decision(choice(.78, .699, "summarize")), "retain")
        self.assertEqual(search_listing._decision(choice(.92, .85, "drop")), "drop")
        self.assertEqual(search_listing._decision(choice(.919, .85, "drop")), "summarize")
        self.assertEqual(search_listing._decision(choice(.92, .849, "drop")), "summarize")


if __name__ == "__main__":
    unittest.main()
