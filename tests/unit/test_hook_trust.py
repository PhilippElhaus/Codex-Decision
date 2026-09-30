"""Tests for the read-only installed-hook trust check."""

import importlib.util
from pathlib import Path
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("check_hook_trust", ROOT / "scripts/check_hook_trust.py")
checker = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(checker)


def response(status="trusted", enabled=True, plugin_id="codex-jev@personal"):
    return {"data": [{"cwd": str(ROOT), "hooks": [{
        "source": "plugin", "eventName": "postToolUse", "pluginId": plugin_id,
        "handlerType": "command", "enabled": enabled, "trustStatus": status,
    }]}]}


class HookTrustTests(unittest.TestCase):
    def test_trusted_hook_is_ready(self):
        self.assertEqual(checker.jev_status(response(), None), ("codex-jev@personal", "trusted"))

    def test_changed_or_disabled_hook_is_not_ready(self):
        self.assertEqual(checker.jev_status(response("modified"), None)[1], "modified")
        self.assertEqual(checker.jev_status(response(enabled=False), None)[1], "disabled")

    def test_missing_or_ambiguous_hook_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, "Expected one"):
            checker.jev_status(response(plugin_id="other@personal"), None)
        duplicate = response()
        duplicate["data"][0]["hooks"].append(response(plugin_id="codex-jev@another")["data"][0]["hooks"][0])
        with self.assertRaisesRegex(RuntimeError, "Expected one"):
            checker.jev_status(duplicate, None)
        self.assertEqual(checker.jev_status(duplicate, "codex-jev@another")[0], "codex-jev@another")


if __name__ == "__main__":
    unittest.main()
