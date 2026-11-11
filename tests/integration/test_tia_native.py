"""Prove V8 function evidence and explicit source reads preserve selection."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("tia_integration_common", ROOT / "scripts/tia/common.py")
TIA = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TIA)


class NativeFunctionCoverageTests(unittest.TestCase):
    def test_v8_function_evidence_and_native_name_filter_agree(self):
        with tempfile.TemporaryDirectory(prefix="decision-tia-native-") as directory:
            root = Path(directory)
            entry, output = root / "probe.test.cjs", root / "coverage.json"
            module = str(ROOT / "vscode-control/providers.js")
            entry.write_text('const test = require("node:test");\n'
                             f'const provider = require({json.dumps(module)});\n'
                             'test("wire", () => provider.wireRequest({model:"jev-latest"}, "jev"));\n'
                             'test("lookup", () => provider.provider("openai"));\n', encoding="utf-8")
            with entry.open("a", encoding="utf-8") as source_file:
                source_file.write(f'test("inspect", () => require("node:fs").readFileSync({json.dumps(module)}));\n')
            env = dict(os.environ, DECISION_TIA_ENTRY=str(entry), DECISION_TIA_RECORD=str(output),
                       DECISION_TIA_WORKER_PID="")
            subprocess.run(["node", "--require", str(ROOT / "scripts/tia/node-coverage.cjs"),
                            "--test", str(entry)], env=env, check=True, capture_output=True, text=True)
            record = json.loads(output.read_text(encoding="utf-8"))
            name = "vscode-control/providers.js"
            source = (ROOT / name).read_text(encoding="utf-8")
            before = {name: {"hash": "before", "text": source}}
            after = {name: {"hash": "after", "text": source.replace(
                'if (protocol === "jev") return request;', 'if (protocol === "jev") return { ...request };')}}
            self.assertNotEqual(before, after)
            baseline = {"version": TIA.VERSION, "environment": {}, "files": before,
                        "tests": record["tests"], "functions": record["functions"]}
            with patch.object(TIA, "environment", return_value={}):
                plan = TIA.select("node", baseline, after)
            self.assertEqual(plan["mode"], "selected")
            self.assertEqual([t["name"] for t in plan["tests"]], ["wire", "inspect"])
            result = subprocess.run(["node", "--test", "--test-reporter=tap", "--test-name-pattern=^(wire|inspect)$",
                                     str(entry)], check=True, capture_output=True, text=True)
            self.assertIn("# pass 2", result.stdout)


if __name__ == "__main__":
    unittest.main()
