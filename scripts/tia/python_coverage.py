"""Collect function calls per unittest case, including fixture/discovery calls."""
import ast
import os
from pathlib import Path
import sys
import unittest

from common import ROOT


def code_identity(code):
    # CodeType equality excludes co_filename. Equal bodies in separate source
    # files must never share a cached coverage location.
    return code, code.co_filename, code.co_firstlineno


def collect():
    functions, by_line, common, active, tests, code_cache = {}, {}, {}, {}, [], {}
    prefix = str(ROOT) + "/"
    reads, common_reads, auditing = set(), set(), {"enabled": True, "paused": False}

    def audit(event, args):
        if event == "subprocess.Popen" and auditing["enabled"]:
            reads.add("*process*")
            return
        if event != "open" or not auditing["enabled"] or auditing["paused"] or not isinstance(args[0], (str, bytes)):
            return
        raw = os.path.abspath(os.fsdecode(args[0])).replace("\\", "/")
        normalized = prefix.replace("\\", "/")
        if raw.startswith(normalized) and raw.endswith((".py", ".js", ".cjs", ".rs")):
            name = raw[len(normalized):]
            if not name.startswith(("scripts/tia/", ".local/", ".cache/")):
                reads.add(name)

    sys.addaudithook(audit)

    def trace(frame, event, _arg):
        if event != "call":
            return
        code = frame.f_code
        identity = code_identity(code)
        if identity in code_cache:
            item = code_cache[identity]
            if item:
                name, span = item
                bucket = active.setdefault(name, [])
                if span not in bucket:
                    bucket.append(span)
            return
        code_cache[identity] = None
        raw = code.co_filename.replace("\\", "/")
        normalized_prefix = prefix.replace("\\", "/")
        if not raw.startswith(normalized_prefix) or not raw.endswith(".py"):
            return
        name = raw[len(normalized_prefix):]
        if name.startswith("scripts/tia/"):
            return
        path = ROOT / name
        if name not in by_line:
            auditing["paused"] = True
            try:
                tree = ast.parse(path.read_text(encoding="utf-8"))
            finally:
                auditing["paused"] = False
            nodes = [n for n in ast.walk(tree) if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda))]
            functions[name] = [[min([n.lineno, *[d.lineno for d in getattr(n, "decorator_list", [])]]), n.end_lineno]
                               for n in nodes]
            by_line[name] = {n.lineno: span for n, span in zip(nodes, functions[name])}
        line = frame.f_code.co_firstlineno
        owners = [s for s in functions[name] if s[0] <= line <= s[1]]
        if owners:
            span = min(owners, key=lambda s: s[1] - s[0])
            code_cache[identity] = (name, span)
            bucket = active.setdefault(name, [])
            if span not in bucket:
                bucket.append(span)

    class Result(unittest.TextTestResult):
        def startTest(self, test):
            common_reads.update(reads)
            reads.clear()
            for name, spans in active.items():
                common.setdefault(name, []).extend(s for s in spans if s not in common.get(name, []))
            active.clear()
            super().startTest(test)

        def stopTest(self, test):
            tests.append({"id": test.id(), "spans": {k: list(v) for k, v in active.items()}, "reads": sorted(reads)})
            reads.clear()
            active.clear()
            super().stopTest(test)

    previous = sys.gettrace()
    sys.settrace(trace)
    try:
        sys.path.insert(0, str(ROOT))
        suite = unittest.defaultTestLoader.discover(str(ROOT / "tests"), pattern="test_*.py", top_level_dir=str(ROOT))
        result = unittest.TextTestRunner(verbosity=1, resultclass=Result).run(suite)
    finally:
        sys.settrace(previous)
        auditing["enabled"] = False
    common_reads.update(reads)
    for name, spans in active.items():
        common.setdefault(name, []).extend(s for s in spans if s not in common.get(name, []))
    for test in tests:
        test["reads"] = sorted(set(test["reads"]) | common_reads)
        for name, spans in common.items():
            target = test["spans"].setdefault(name, [])
            target.extend(s for s in spans if s not in target)
    if not result.wasSuccessful():
        raise RuntimeError("Python suite failed; baseline was not updated")
    return tests, functions
