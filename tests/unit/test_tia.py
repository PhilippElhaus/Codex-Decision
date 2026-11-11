"""Safety boundaries for function selection, independent of the native runners."""
from copy import deepcopy
import importlib.util
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

SOURCE = Path(__file__).resolve().parents[2] / "scripts/tia/common.py"
SPEC = importlib.util.spec_from_file_location("decision_tia_common", SOURCE)
TIA = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(TIA)


class FunctionSelectionTests(unittest.TestCase):
    def setUp(self):
        self.name = "vscode-control/providers.js"
        self.files = {self.name: {"hash": "before", "text": "const a = 1;\nfunction first() {\n return 1;\n}\nfunction second() {\n return 2;\n}\n"}}
        self.baseline = {"version": TIA.VERSION, "environment": {}, "files": self.files,
                         "functions": {self.name: [[2, 4], [5, 7]]},
                         "tests": [{"id": "first", "spans": {self.name: [[2, 4]]}},
                                   {"id": "second", "spans": {self.name: [[5, 7]]}}]}
        self.runtime = patch.object(TIA, "environment", return_value={})
        self.runtime.start()
        self.addCleanup(self.runtime.stop)

    def change(self, before, after):
        current = deepcopy(self.files)
        current[self.name] = {"hash": "after", "text": self.files[self.name]["text"].replace(before, after)}
        return current

    def test_function_change_selects_exact_cases_in_all_native_families(self):
        for family, name in [("node", self.name), ("rust", "rust/decision/src/provider.rs"),
                             ("python", "scripts/verify_packages.py")]:
            with self.subTest(family=family):
                baseline = deepcopy(self.baseline)
                baseline["files"] = {name: self.files[self.name]}
                baseline["functions"] = {name: [[2, 4], [5, 7]]}
                for test in baseline["tests"]:
                    test["spans"] = {name: test["spans"][self.name]}
                current = {name: self.change("return 1", "return 3")[self.name]}
                plan = TIA.select(family, baseline, current)
                self.assertEqual(plan["mode"], "selected")
                self.assertEqual([t["id"] for t in plan["tests"]], ["first"])

    def test_missing_stale_and_uncovered_evidence_runs_full(self):
        for baseline in [None, {**self.baseline, "version": -1},
                         {**self.baseline, "environment": {"runtime": "another"}},
                         {**self.baseline, "functions": {}},
                         {**self.baseline, "tests": self.baseline["tests"][1:]}]:
            self.assertEqual(TIA.select("node", baseline, self.change("return 1", "return 3"))["mode"], "full")

    def test_source_readers_and_process_boundaries_remain_selected(self):
        baseline = deepcopy(self.baseline)
        baseline["tests"].extend([
            {"id": "reader", "spans": {}, "reads": [self.name]},
            {"id": "child", "spans": {}, "reads": ["*process*"]}])
        plan = TIA.select("node", baseline, self.change("return 1", "return 3"))
        self.assertEqual([t["id"] for t in plan["tests"]], ["first", "reader", "child"])

    def test_equal_python_bodies_keep_their_own_source_locations(self):
        spec = importlib.util.spec_from_file_location("decision_tia_python", SOURCE.with_name("python_coverage.py"))
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"common": TIA}):
            spec.loader.exec_module(module)
        first = compile("def f(): return None", "/first.py", "exec").co_consts[0]
        second = compile("def f(): return None", "/second.py", "exec").co_consts[0]
        self.assertEqual(first, second)
        locations = {module.code_identity(first): "first", module.code_identity(second): "second"}
        self.assertEqual(len(locations), 2)

    def test_module_level_new_deleted_fixture_and_cross_language_inputs_run_full(self):
        for current in [self.change("const a = 1", "const a = 2"), {},
                        {**self.files, "tests/unit/new.test.cjs": {"hash": "new"}},
                        {**self.files, "tests/fixtures/a.json": {"hash": "new"}},
                        {**self.files, "rust/decision/src/lib.rs": {"hash": "new"}}]:
            self.assertEqual(TIA.select("node", self.baseline, current)["mode"], "full")

    def test_insertion_at_function_boundary_does_not_inherit_coverage(self):
        current = self.change("}\nfunction second", "}\nconst imported = dynamic();\nfunction second")
        self.assertEqual(TIA.select("node", self.baseline, current)["mode"], "full")

    def test_unchanged_source_can_skip_and_documentation_still_runs_python(self):
        self.assertEqual(TIA.select("node", self.baseline, self.files)["tests"], [])
        current = {**self.files, "docs/README.md": {"hash": "new"}}
        self.assertEqual(TIA.select("node", self.baseline, current)["mode"], "selected")
        self.assertEqual(TIA.select("python", self.baseline, current)["mode"], "full")

    def test_renamed_rust_case_cannot_pass_with_zero_tests(self):
        spec = importlib.util.spec_from_file_location("decision_tia_rust", SOURCE.with_name("rust.py"))
        module = importlib.util.module_from_spec(spec)
        with patch.dict(sys.modules, {"common": TIA}):
            spec.loader.exec_module(module)
        target = {"kind": "lib", "target": "codex_decision", "executable": "/fixture/tests"}
        stale = {"kind": "lib", "target": "codex_decision", "name": "old_name"}
        with patch.object(module, "artifacts", return_value=([target], [])), \
                patch.object(module, "command", return_value=SimpleNamespace(stdout="new_name: test\n")) as run:
            module.run_selected([stale])
        self.assertEqual(run.call_args.args[0], ["cargo", "test", "--locked", "-p", "codex-decision"])

    def test_byte_only_changes_and_corrupt_manifests_cannot_skip_tests(self):
        current = self.change("\n", "\r\n")
        self.assertEqual(TIA.select("node", self.baseline, current)["mode"], "full")
        with tempfile.TemporaryDirectory(prefix="decision-tia-manifest-") as directory, \
                patch.object(TIA, "STATE", Path(directory)):
            TIA.save("node", self.files, self.baseline["tests"], self.baseline["functions"])
            self.assertIsNotNone(TIA.load("node"))
            path = TIA.baseline_path("node")
            import json
            value = json.loads(path.read_text(encoding="utf-8"))
            value["tests"][0]["spans"] = {}
            path.write_text(json.dumps(value), encoding="utf-8")
            self.assertIsNone(TIA.load("node"))


if __name__ == "__main__":
    unittest.main()
