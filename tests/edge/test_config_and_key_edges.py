"""Reject malformed settings and credential files before a Jev request."""

import json
import os
from pathlib import Path
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "hooks"))
import jev  # noqa: E402


class ConfigAndKeyEdgeTests(unittest.TestCase):
    def test_nested_cutoffs_reject_non_integer_and_unknown_values(self):
        cases = (
            {"output": {"routine_min": True}},
            {"output": {"routine_min": 90.0}},
            {"output": {"routine_min": -1}},
            {"output": {"routine_min": 101}},
            {"output": {"unknown": 90}},
            {"unknown": {"routine_min": 90}},
            {"output": []},
        )
        with tempfile.TemporaryDirectory(prefix="jev-config-edge-", dir="/tmp") as directory:
            config = Path(directory) / "config.json"
            for thresholds in cases:
                with self.subTest(thresholds=thresholds):
                    config.write_text(json.dumps({"thresholds": thresholds}), encoding="utf-8")
                    with self.assertRaises(ValueError):
                        jev.Config.from_file(config)

    def test_private_key_parser_accepts_bom_and_quotes_but_rejects_duplicates(self):
        with tempfile.TemporaryDirectory(prefix="jev-key-edge-", dir="/tmp") as directory:
            key = Path(directory) / ".env"
            key.write_text("\ufeff# synthetic fixture\nJEV_API_KEY='synthetic-test-key'\n", encoding="utf-8")
            key.chmod(0o600)
            self.assertEqual(jev.load_api_key(Path(directory)), "synthetic-test-key")
            key.write_text("JEV_API_KEY=synthetic-one\nJEV_API_KEY=synthetic-two\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                jev.load_api_key(Path(directory))

    @unittest.skipUnless(os.name != "nt" and hasattr(os, "O_NOFOLLOW"), "POSIX file protections required")
    def test_credential_permissions_size_and_symlink_are_rejected(self):
        with tempfile.TemporaryDirectory(prefix="jev-key-protection-", dir="/tmp") as directory:
            root = Path(directory)
            key = root / ".env"
            key.write_text("JEV_API_KEY=synthetic-test-key\n", encoding="utf-8")
            key.chmod(0o644)
            with self.assertRaises(ValueError):
                jev.load_api_key(root)
            key.chmod(0o600)
            key.write_text("JEV_API_KEY=" + "x" * 8192, encoding="utf-8")
            with self.assertRaises(ValueError):
                jev.load_api_key(root)
            key.unlink()
            target = root / "target"
            target.write_text("JEV_API_KEY=synthetic-test-key\n", encoding="utf-8")
            target.chmod(0o600)
            key.symlink_to(target)
            with self.assertRaises(OSError):
                jev.load_api_key(root)


if __name__ == "__main__":
    unittest.main()
