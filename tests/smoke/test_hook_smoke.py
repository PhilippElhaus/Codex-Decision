"""Check the installed hook entry point with a private, key-free fixture."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
HOOK = ROOT / "hooks/post_tool_use.py"


class HookSmokeTests(unittest.TestCase):
    def test_disabled_malformed_and_small_events_keep_the_tool_result(self):
        with tempfile.TemporaryDirectory(prefix="jev-smoke-", dir="/tmp") as directory:
            config = Path(directory) / "config.json"
            event = {"hook_event_name": "PostToolUse", "tool_name": "Bash",
                     "tool_input": {"command": "printf done"}, "tool_response": "done\n"}
            for name, settings, payload in (
                ("disabled", {}, json.dumps(event)),
                ("malformed event", {"enabled": True}, "{"),
                ("small event", {"enabled": True}, json.dumps(event)),
            ):
                with self.subTest(case=name):
                    config.write_text(json.dumps(settings), encoding="utf-8")
                    process = subprocess.run(
                        [sys.executable, str(HOOK)], input=payload, capture_output=True, text=True,
                        env={**os.environ, "PLUGIN_DATA": directory}, timeout=10, check=True,
                    )
                    self.assertEqual(process.stdout, "{}\n")
                    self.assertEqual(process.stderr, "")


if __name__ == "__main__":
    unittest.main()
