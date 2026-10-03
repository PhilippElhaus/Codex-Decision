"""Keep the version 3 example and VS Code bridge on one line policy."""

import json
from pathlib import Path
import shutil
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]
class DefaultsContractTests(unittest.TestCase):
    def test_hook_extension_and_example_use_the_same_defaults(self):
        if not shutil.which("node"):
            self.skipTest("Node is unavailable")
        extension = ROOT / "vscode-control/core.js"
        result = subprocess.run(
            ["node", "-e", "process.stdout.write(JSON.stringify(require(process.argv[1]).DEFAULT_RELEVANCE_POLICY))",
             str(extension)], capture_output=True, text=True, check=True,
        )
        node_defaults = json.loads(result.stdout)
        example = json.loads((ROOT / "config.example.json").read_text(encoding="utf-8"))
        self.assertEqual(example["schema_version"], 4)
        self.assertEqual(example["relevance_policy"], node_defaults)
        self.assertNotIn("thresholds", example)
        self.assertNotIn("decision_methods", example)
        self.assertEqual(example["mode"], "replace")
        self.assertEqual(example["log_limit_mb"], 50)
        self.assertFalse(example["never_delete_logs"])


if __name__ == "__main__":
    unittest.main()
