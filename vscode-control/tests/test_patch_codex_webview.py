"""Exercise apply/update/restore against a disposable extension fixture."""

import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[1] / "patch_codex_webview.py"
SPEC = importlib.util.spec_from_file_location("jev_patch", SOURCE)
patch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(patch)


class PatchTests(unittest.TestCase):
    def test_marketplace_bridge_rewrites_only_this_wsl_marketplace(self):
        if not shutil.which("node") or not patch.marketplace_path_bridge():
            self.skipTest("Windows-to-WSL bridge is unavailable here")
        linux_path = str(SOURCE.resolve().parents[3] / ".agents/plugins/marketplace.json")
        for incoming, name, expected in (
            (r"D:\Codex\.agents\plugins\marketplace.json", "codex-jev", linux_path),
            (r"D:\Codex\.agents\plugins\marketplace.json", "codex-chime", linux_path),
            ("./.agents/plugins/marketplace.json", "codex-jev", linux_path),
            ("./.agents/plugins/marketplace.json", "another-plugin", "./.agents/plugins/marketplace.json"),
            (r"C:\Elsewhere\marketplace.json", "codex-jev", r"C:\Elsewhere\marketplace.json"),
        ):
            message = {"type": "mcp-request", "request": {"method": "plugin/read", "params": {
                "marketplacePath": incoming, "pluginName": name,
            }}}
            script = (
                "let u=" + json.dumps(message) + ";" + patch.marketplace_path_bridge()
                + "process.stdout.write(JSON.stringify(u.request.params));"
            )
            result = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
            self.assertEqual(json.loads(result.stdout)["marketplacePath"], expected)

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="jev-patch-test-", dir="/tmp")
        self.addCleanup(self.temp.cleanup)
        self.extension = Path(self.temp.name) / f"openai.chatgpt-{patch.VERSION}"
        self.backup = Path(self.temp.name) / "rollback"
        original = {
            "out/extension.js": ("prefix " + patch.ANCHOR + " suffix").encode(),
            "webview/index.html": ("<html>" + patch.MODULE + "</html>").encode(),
        }
        for relative, content in original.items():
            destination = self.extension / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        (self.extension / "webview/assets").mkdir()
        self.original = original
        self.digests = {name: hashlib.sha256(value).hexdigest() for name, value in original.items()}
        self.original_patch = mock.patch.object(patch, "ORIGINAL", self.digests)
        self.original_patch.start()
        self.addCleanup(self.original_patch.stop)

    def test_apply_update_restore_and_tamper_rejection(self):
        patch.apply(self.extension, self.backup)
        manifest_path = self.backup / "manifest.json"
        first = json.loads(manifest_path.read_text())
        self.assertIn("codexJev.bridge", (self.extension / "out/extension.js").read_text())
        self.assertIn("feature:u.feature", (self.extension / "out/extension.js").read_text())
        self.assertIn("viewId", (self.extension / "out/extension.js").read_text())
        self.assertEqual((self.extension / patch.ASSET).read_bytes(),
                         (SOURCE.parent / "webview/jev-control.js").read_bytes())

        patch.update(self.extension, self.backup)
        second = json.loads(manifest_path.read_text())
        self.assertEqual(first, second)
        self.assertEqual((self.backup / "out/extension.js").read_bytes(), self.original["out/extension.js"])

        host = self.extension / "out/extension.js"
        host.write_bytes(host.read_bytes() + b"tampered")
        with self.assertRaises(RuntimeError):
            patch.update(self.extension, self.backup)
        host.write_bytes(host.read_bytes()[:-8])
        patch.restore(self.extension, self.backup)
        self.assertFalse((self.extension / patch.ASSET).exists())
        for relative, content in self.original.items():
            self.assertEqual((self.extension / relative).read_bytes(), content)


if __name__ == "__main__":
    unittest.main()
