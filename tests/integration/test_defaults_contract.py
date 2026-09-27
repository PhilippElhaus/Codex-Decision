"""Keep the hook, VS Code bridge, and example config on one set of cutoffs."""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "hooks"))
import jev  # noqa: E402


class DefaultsContractTests(unittest.TestCase):
    def test_hook_extension_and_example_use_the_same_defaults(self):
        if not shutil.which("node"):
            self.skipTest("Node is unavailable")
        extension = ROOT / "vscode-control/core.js"
        result = subprocess.run(
            ["node", "-e", "process.stdout.write(JSON.stringify(require(process.argv[1]).DEFAULT_THRESHOLDS))",
             str(extension)], capture_output=True, text=True, check=True,
        )
        node_defaults = json.loads(result.stdout)
        example = json.loads((ROOT / "config.example.json").read_text(encoding="utf-8"))
        self.assertEqual(node_defaults, jev.DEFAULT_THRESHOLDS)
        self.assertEqual(example["thresholds"], node_defaults)
        self.assertEqual(jev.Config().thresholds, node_defaults)
        self.assertEqual(example["mode"], jev.Config().mode)


if __name__ == "__main__":
    unittest.main()
