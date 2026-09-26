#!/usr/bin/env python3
"""Run one real Jev-backed replacement for each selected PostToolUse filter."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys
import tempfile
from uuid import uuid4


PLUGIN = Path(__file__).resolve().parents[1]
REPO = PLUGIN.parents[1]
ORIGINAL_PATH = re.compile(r"full original: ([^\]\r\n]+\.txt)", re.IGNORECASE)


def invoke(hook: Path, data: Path, run_id: str, name: str, command: str,
           output: str, transcript: Path | None = None) -> dict:
    event = {
        "hook_event_name": "PostToolUse", "tool_name": "Bash",
        "session_id": f"jev-visible-samples-{run_id}", "turn_id": f"sample-{name}",
        "tool_use_id": f"{run_id}-{name}", "tool_input": {"command": command},
        "tool_response": output,
    }
    if transcript is not None:
        event["transcript_path"] = str(transcript)
    log = data / "events.jsonl"
    offset = log.stat().st_size if log.exists() else 0
    completed = subprocess.run([sys.executable, str(hook)], input=json.dumps(event),
                               text=True, capture_output=True, timeout=20, check=True,
                               env={**os.environ, "PLUGIN_DATA": str(data)})
    if completed.stderr:
        raise RuntimeError(f"{name} hook wrote to stderr")
    feedback = json.loads(completed.stdout)
    rows = [json.loads(line) for line in log.read_bytes()[offset:].decode().splitlines()]
    expected_filter = {"output": "output", "test_build": "test_build", "search_listing": "search_listing"}[name]
    if ([(row["filter"], row["status"]) for row in rows]
            != [(expected_filter, "calling"), (expected_filter, "replace")]
            or feedback.get("continue") is not False):
        raise AssertionError(f"{name} did not replace via Jev: {rows}")
    visible = feedback["reason"]
    match = ORIGINAL_PATH.search(visible)
    if not match:
        raise AssertionError(f"{name} replacement omitted its recovery path")
    original = Path(match.group(1))
    if (not original.is_file() or original.is_symlink() or not original.is_relative_to(data)
            or original.read_text() != output or stat.S_IMODE(original.stat().st_mode) != 0o600):
        raise AssertionError(f"{name} original was not saved exactly with owner-only permissions")
    if rows[1]["original_chars"] != len(output) or rows[1]["capsule_chars"] != len(visible):
        raise AssertionError(f"{name} size accounting is inaccurate")
    return {
        "filter": name, "original_chars": len(output), "visible_chars": len(visible),
        "saved_chars": len(output) - len(visible),
        "saved_percent": round(100 * (1 - len(visible) / len(output)), 1),
        "hook_ms": rows[1]["elapsed_ms"], "exact_original_saved": True,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hook-script", type=Path, default=PLUGIN / "hooks/post_tool_use.py")
    parser.add_argument("--data-dir", type=Path,
                        help="Existing live PLUGIN_DATA directory; omit for disposable test data")
    args = parser.parse_args()
    hook = args.hook_script.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="jev-three-samples-", dir="/tmp") as temporary:
        root = Path(temporary)
        data = args.data_dir.resolve(strict=True) if args.data_dir else root / "plugin-data"
        if not args.data_dir:
            data.mkdir(mode=0o700)
            (data / "config.json").write_text(json.dumps({
                "enabled": True, "test_build_enabled": True,
                "search_listing_enabled": True, "mode": "replace",
            }))
        if data.is_symlink() or not data.is_dir():
            raise ValueError("unsafe plugin data directory")
        selected = json.loads((data / "config.json").read_text())
        if (not all(selected.get(key) is True for key in
                    ("enabled", "test_build_enabled", "search_listing_enabled"))
                or selected.get("mode") != "replace"):
            raise ValueError("all three Jev filters must be selected in replace mode")
        run_id = uuid4().hex[:16]
        results = []

        script = 'for n in range(400): print(f"Compiling module {n:05d} ... done")'
        command = shlex.join([sys.executable, "-c", script])
        output = subprocess.run([sys.executable, "-c", script], cwd=REPO,
                                capture_output=True, text=True, check=True).stdout
        results.append(invoke(hook, data, run_id, "output", command, output))

        test_command = [sys.executable, "-m", "unittest", "discover", "-s", "plugins/codex-jev/tests", "-v"]
        test_run = subprocess.run(test_command, cwd=REPO, stdout=subprocess.PIPE,
                                  stderr=subprocess.STDOUT, text=True, timeout=90, check=True)
        results.append(invoke(hook, data, run_id, "test_build", shlex.join(test_command), test_run.stdout))

        corpus = root / "corpus"
        auth = corpus / "src/auth"
        archive = corpus / "docs/archive/2018-marketing"
        auth.mkdir(parents=True)
        archive.mkdir(parents=True)
        for number in range(120):
            (auth / f"token_validation_{number:03d}.py").write_text("# auth source\n")
        for number in range(200):
            (archive / f"campaign_{number:03d}.md").write_text("# archived marketing\n")
        listing = subprocess.run(["rg", "--files"], cwd=corpus,
                                 capture_output=True, text=True, check=True).stdout
        transcript = root / "thread.jsonl"
        transcript.write_text(json.dumps({
            "type": "response_item", "payload": {"role": "user", "content": [{
                "type": "input_text",
                "text": "Locate current authentication token validation code. Archived 2018 marketing documents are unrelated to this task.",
            }]},
        }) + "\n")
        results.append(invoke(hook, data, run_id, "search_listing", "rg --files", listing, transcript))
        print(json.dumps({"hook": str(hook), "visible_in_plugin_history": bool(args.data_dir),
                          "results": results}, indent=2))


if __name__ == "__main__":
    main()
