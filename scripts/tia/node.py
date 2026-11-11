"""Native node:test execution with precise per-case function coverage."""
import json
import os
from pathlib import Path
import re

from common import ROOT, command, temporary_directory


def collect():
    tests, functions = [], {}
    with temporary_directory("decision-tia-node-") as directory:
        for index, entry in enumerate(sorted((ROOT / "tests").rglob("*.test.cjs"))):
            name = entry.relative_to(ROOT).as_posix()
            output = Path(directory) / f"{index}.json"
            env = dict(os.environ, DECISION_TIA_RECORD=str(output), DECISION_TIA_ENTRY=name,
                       DECISION_TIA_WORKER_PID="")
            command(["node", "--require", ROOT / "scripts/tia/node-coverage.cjs", "--test", entry], env=env)
            recorded = json.loads(output.read_text(encoding="utf-8"))
            # Platform-only workers can contain only skipped cases. They still
            # ran successfully; keep an explicit worker marker, never infer
            # function coverage for their skipped bodies.
            tests.extend(recorded["tests"] or [{"id": name + "::*", "file": name,
                                                "name": "", "spans": {}, "skipped_file": True}])
            for path, spans in recorded["functions"].items():
                target = functions.setdefault(path, [])
                target.extend(s for s in spans if s not in target)
    if len({test["id"] for test in tests}) != len(tests):
        raise ValueError("Duplicate Node test identities; refusing partial coverage")
    return tests, functions


def run_selected(tests):
    grouped = {}
    for test in tests:
        grouped.setdefault(test["file"], []).append(test["name"])
    for entry, names in grouped.items():
        if not all(names):
            command(["node", "--test", entry])
            continue
        # A parent match includes its nested lifecycle. Escape names as literals.
        pattern = "^(?:" + "|".join(re.escape(name) for name in names) + ")(?:$| )"
        command(["node", "--test", f"--test-name-pattern={pattern}", entry])
