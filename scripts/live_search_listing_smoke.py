#!/usr/bin/env python3
"""Exercise the search/listing PostToolUse route with real rg and live Jev."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

PLUGIN = Path(__file__).resolve().parents[1]
REPO = PLUGIN.parents[1]


def invoke(hook: Path, data: Path, command: str, output: str, call: str, task: str) -> tuple[dict, list[dict]]:
    (data / "config.json").write_text(json.dumps({
        "enabled": True, "test_build_enabled": True,
        "search_listing_enabled": True, "mode": "replace", "timeout_seconds": 4.0,
    }))
    transcript = data / "thread.jsonl"
    transcript.write_text(json.dumps({
        "type": "response_item", "payload": {"role": "user", "content": [
            {"type": "input_text", "text": task},
        ]},
    }) + "\n")
    event = {
        "hook_event_name": "PostToolUse", "tool_name": "Bash", "session_id": "live-search-smoke",
        "turn_id": "live-turn", "tool_use_id": call, "tool_input": {"command": command},
        "tool_response": output, "transcript_path": str(transcript),
    }
    log = data / "events.jsonl"
    previous = len(log.read_text().splitlines()) if log.exists() else 0
    completed = subprocess.run([sys.executable, str(hook)], input=json.dumps(event),
                               text=True, capture_output=True, timeout=20, check=True,
                               env={**os.environ, "PLUGIN_DATA": str(data)})
    rows = [json.loads(line) for line in log.read_text().splitlines()[previous:]]
    assert [(row["filter"], row["status"]) for row in rows[:1]] == [("search_listing", "calling")], rows
    assert len(rows) == 2 and rows[1]["filter"] == "search_listing", rows
    return json.loads(completed.stdout), rows


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hook-script", type=Path, default=PLUGIN / "hooks/post_tool_use.py")
    args = parser.parse_args()
    hook = args.hook_script.resolve(strict=True)
    with tempfile.TemporaryDirectory(prefix="jev-live-search-", dir="/tmp") as temporary:
        root = Path(temporary)
        data = root / "plugin-data"
        data.mkdir()
        command = ["rg", "-n", "return ", "plugins/codex-jev/hooks", "plugins/codex-jev/vscode-control"]
        output = subprocess.run(command, cwd=REPO, capture_output=True, text=True, check=True).stdout
        response, rows = invoke(hook, data, "rg -n 'return ' plugins/codex-jev/hooks plugins/codex-jev/vscode-control",
                                output, "repo-rg", "Inspect Python hook return paths; JavaScript UI return paths are irrelevant to this immediate task.")
        assert rows[1]["status"] in {"keep", "candidate", "replace"}, rows
        if rows[1]["status"] != "replace":
            assert response == {}, response

        corpus = root / "corpus"
        auth = corpus / "src/auth"
        archive = corpus / "docs/archive/2018-marketing"
        auth.mkdir(parents=True)
        archive.mkdir(parents=True)
        for number in range(120):
            (auth / f"token_validation_{number:03d}.py").write_text("# auth source\n")
        for number in range(200):
            (archive / f"campaign_{number:03d}.md").write_text("# archived marketing\n")
        listed = subprocess.run(["rg", "--files"], cwd=corpus, capture_output=True, text=True, check=True).stdout
        assert len(listed.splitlines()) == 320
        listing, listing_rows = invoke(hook, data, "rg --files", listed, "real-listing",
                                      "Locate current authentication token validation code. Archived 2018 marketing documents are unrelated to this task.")
        assert listing_rows[1]["status"] == "replace", listing_rows
        assert listing.get("continue") is False and "src/auth/" in listing["reason"], listing
        assert "docs/archive/2018-marketing/campaign_" not in listing["reason"], listing
        originals = list((data / "outputs").rglob("*.txt"))
        assert any(path.read_text() == listed for path in originals), originals
        print(json.dumps({
            "hook": str(hook), "repo_search": {"status": rows[1]["status"], "chars": len(output),
                                                   "elapsed_ms": rows[1]["elapsed_ms"]},
            "real_listing": {"status": listing_rows[1]["status"], "chars": len(listed),
                              "visible_chars": len(listing["reason"]), "elapsed_ms": listing_rows[1]["elapsed_ms"],
                              "saved_percent": round(100 * (1 - len(listing["reason"]) / len(listed)), 1)},
        }, indent=2))


if __name__ == "__main__":
    main()
