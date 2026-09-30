"""Guard the release package against an older hook binary/control pairing."""

import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("release_versions", ROOT / "scripts/check_release_versions.py")
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)


class ReleaseVersionTests(unittest.TestCase):
    def test_checked_in_versions_match(self):
        self.assertEqual(checker.check(), "0.8.0")

    def test_mismatched_control_or_plugin_blocks_package(self):
        with tempfile.TemporaryDirectory(prefix="jev-release-test-", dir="/tmp") as temporary:
            root = Path(temporary)
            for name in ("rust/jev/Cargo.toml", ".codex-plugin/plugin.json", "vscode-control/package.json"):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((ROOT / name).read_bytes())
            self.assertEqual(checker.check(root), "0.8.0")
            control = root / "vscode-control/package.json"
            value = json.loads(control.read_text())
            value["codexJevHookVersion"] = "0.6.0"
            control.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError, "versions differ"):
                checker.check(root)
            control.write_bytes((ROOT / "vscode-control/package.json").read_bytes())
            plugin = root / ".codex-plugin/plugin.json"
            value = json.loads(plugin.read_text())
            value["version"] = "0.6.0+codex.old"
            plugin.write_text(json.dumps(value))
            with self.assertRaisesRegex(ValueError, "versions differ"):
                checker.check(root)


if __name__ == "__main__":
    unittest.main()
