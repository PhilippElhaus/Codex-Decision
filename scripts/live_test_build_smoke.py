#!/usr/bin/env python3
"""Exercise the PostToolUse adapter with output from real local test/build commands."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


PLUGIN = Path(__file__).resolve().parents[1]
REPO = PLUGIN
DEFAULT_HOOK = PLUGIN / "hooks" / "post_tool_use.py"


def run(command: list[str], cwd: Path) -> tuple[str, int]:
    completed = subprocess.run(command, cwd=cwd, stdout=subprocess.PIPE,
                               stderr=subprocess.STDOUT, text=True, timeout=90, check=False)
    return completed.stdout, completed.returncode


def invoke(hook: Path, data: Path, command: str, output: str, call: str, mode: str = "replace") -> tuple[dict, dict]:
    (data / "config.json").write_text(json.dumps({
        "enabled": False, "test_build_enabled": True, "mode": mode,
    }))
    event = {
        "hook_event_name": "PostToolUse", "tool_name": "Bash",
        "session_id": "live-test-build-smoke", "turn_id": "smoke-turn",
        "tool_use_id": call, "tool_input": {"command": command}, "tool_response": output,
    }
    log = data / "events.jsonl"
    previous = len(log.read_text().splitlines()) if log.exists() else 0
    completed = subprocess.run([sys.executable, str(hook)], input=json.dumps(event),
                               text=True, capture_output=True, timeout=15, check=True,
                               env={**os.environ, "PLUGIN_DATA": str(data)})
    response = json.loads(completed.stdout)
    new_records = [json.loads(line) for line in log.read_text().splitlines()[previous:]]
    assert [(row["filter"], row["status"]) for row in new_records[:1]] == [("test_build", "calling")], new_records
    assert len(new_records) == 2, new_records
    record = new_records[-1]
    assert record["filter"] == "test_build", record
    assert isinstance(record["scores"], dict) and set(record["scores"]) == {
        "routine_noise", "needs_exact_text", "one_off_value",
    }, record
    return response, record


def verify_replace(hook: Path, data: Path, command: str, output: str, call: str,
                   required: tuple[str, ...]) -> dict:
    response, record = invoke(hook, data, command, output, call)
    assert response.get("continue") is False, (call, record)
    assert record["status"] == "replace", (call, record)
    feedback = response["reason"]
    for fragment in required:
        assert fragment in feedback, (call, fragment)
    match = re.search(r"^Full original: (.+)$", feedback, re.MULTILINE)
    assert match, call
    original = Path(match.group(1))
    assert original.is_file() and original.read_text() == output, call
    assert original.is_relative_to(data), call
    assert record["capsule_chars"] == len(feedback), call
    return {"case": call, "original_chars": len(output), "visible_chars": len(feedback),
            "reduction_percent": round(100 * (1 - len(feedback) / len(output)), 1),
            "jev_scores": record["scores"]}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hook-script", type=Path, default=DEFAULT_HOOK)
    args = parser.parse_args()
    hook = args.hook_script.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="jev-live-test-build-", dir="/tmp") as temporary:
        root = Path(temporary)
        data = root / "plugin-data"
        data.mkdir()
        rows = []

        command = [sys.executable, "-m", "unittest", "discover", "-s", str(PLUGIN / "tests"),
                   "-p", "test_jev.py", "-v"]
        output, code = run(command, REPO)
        assert code == 0 and "Ran " in output, output[-1000:]
        python_output = output
        python_command = f"{sys.executable} -m unittest discover -s {PLUGIN / 'tests'} -v"
        rows.append(verify_replace(hook, data, python_command,
                                   output, "real-python-pass", ("Ran ", "OK")))

        failure_dir = root / "failing-suite"
        failure_dir.mkdir()
        source = "import unittest\nclass Cases(unittest.TestCase):\n" + "".join(
            f"    def test_case_{number:03d}(self): self.assertEqual(1, 1)\n"
            for number in range(80)
        ) + "    def test_case_999(self): self.assertEqual(1, 2)\n"
        (failure_dir / "test_cases.py").write_text(source)
        output, code = run([sys.executable, "-m", "unittest", "discover", "-s", str(failure_dir), "-v"], root)
        assert code != 0 and "AssertionError: 1 != 2" in output, output[-1000:]
        output += f"Process exited with code {code}\n"
        rows.append(verify_replace(hook, data, f"{sys.executable} -m unittest discover -s {failure_dir} -v",
                                   output, "real-python-fail", ("AssertionError: 1 != 2", "FAILED (failures=1)",
                                                                f"Process exited with code {code}")))

        if shutil.which("node"):
            node_dir = root / "node-suite"
            node_dir.mkdir()
            test_file = node_dir / "cases.test.cjs"
            test_file.write_text("const { test } = require('node:test');\n" + "".join(
                f"test('case {number:03d} passes', () => {{}});\n" for number in range(150)
            ))
            output, code = run(["node", "--test", str(test_file)], node_dir)
            assert code == 0 and ("pass 150" in output or "# pass 150" in output), output[-1000:]
            rows.append(verify_replace(hook, data, f"node --test {test_file}", output,
                                       "real-node-pass", ("pass 150", "fail 0")))

        if shutil.which("make") and shutil.which("cc"):
            build_dir = root / "c-build"
            (build_dir / "src").mkdir(parents=True)
            for number in range(90):
                (build_dir / "src" / f"unit_{number:03d}.c").write_text(f"int unit_{number:03d}(void) {{ return {number}; }}\n")
            (build_dir / "Makefile").write_text(
                "SOURCES := $(wildcard src/*.c)\nOBJECTS := $(patsubst src/%.c,obj/%.o,$(SOURCES))\n"
                "build: $(OBJECTS)\n\t@echo BUILD SUCCESSFUL\n"
                "obj/%.o: src/%.c\n\t@mkdir -p obj\n\t@echo Compiling $<\n\t@cc -c $< -o $@\n"
            )
            output, code = run(["make", "build"], build_dir)
            assert code == 0 and len(list((build_dir / "obj").glob("*.o"))) == 90, output[-1000:]
            rows.append(verify_replace(hook, data, "make build", output, "real-c-build", ("BUILD SUCCESSFUL",)))

        observed, record = invoke(hook, data, python_command, python_output, "real-python-observe", "observe")
        assert observed == {} and record["status"] == "candidate" and record["reason"] == "observe"
        print(json.dumps({"hook": str(hook), "results": rows, "observe": record["status"]}, indent=2))


if __name__ == "__main__":
    main()
