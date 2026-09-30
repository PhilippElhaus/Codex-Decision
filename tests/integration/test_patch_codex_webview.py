"""Exercise apply/update/restore against a disposable extension fixture."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock


SOURCE = Path(__file__).resolve().parents[2] / "vscode-control/patch_codex_webview.py"
SPEC = importlib.util.spec_from_file_location("jev_patch", SOURCE)
patch = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(patch)


class PatchTests(unittest.TestCase):
    def test_settings_bridge_forwards_relevance_only_when_valid(self):
        if not shutil.which("node"):
            self.skipTest("Node is unavailable")
        event = {
            "type": "codex-jev", "action": "settingsSave", "key": "",
            "mode": "replace", "linePolicy": {},
            "searchRelevance": {"guard_enabled": True, "relevant_max": 7},
            "logLimitMb": 50, "neverDeleteLogs": False, "choiceGateEnabled": True,
        }
        def forward(message):
            script = (
                'let captured=null,handler=null;'
                'let e={onDidReceiveMessage(f){handler=f;return {}},postMessage(){}},'
                'qe={commands:{executeCommand(_,payload){captured=payload;return Promise.resolve({})}}},'
                's={markMessageReceived(){}};'
                + patch.BRIDGE + '{} });'
                + 'handler(' + json.dumps(message) + ');'
                + 'setTimeout(()=>process.stdout.write(JSON.stringify(captured)),0);'
            )
            result = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True)
            return json.loads(result.stdout)

        self.assertEqual(forward(event)["searchRelevance"], event["searchRelevance"])
        self.assertIs(forward(event)["choiceGateEnabled"], True)
        event["searchRelevance"]["relevant_max"] = 101
        self.assertIsNone(forward(event))

    def test_image_bridge_converts_only_our_wsl_plugin_images(self):
        if not shutil.which("wslpath") or not shutil.which("node"):
            self.skipTest("Windows-to-WSL bridge is unavailable here")
        prefix = str(Path.home() / ".codex/plugins/cache/personal")
        for incoming in (f"{prefix}/codex-jev/1/assets/icon.png",
                         f"{prefix}/codex-chime/1/assets/logo.png", "/tmp/other.png"):
            script = "let i=" + json.dumps(incoming) + ";" + patch.image_path_bridge() + "process.stdout.write(i);"
            output = subprocess.run(["node", "-e", script], capture_output=True, text=True, check=True).stdout
            if incoming.startswith(prefix):
                self.assertTrue(output.startswith("\\\\wsl.localhost\\"))
                self.assertTrue(output.endswith("\\assets\\" + incoming.split("/")[-1]))
            else:
                self.assertEqual(output, incoming)

    def test_marketplace_bridge_rewrites_only_this_wsl_marketplace(self):
        if not shutil.which("node") or not shutil.which("wslpath"):
            self.skipTest("Windows-to-WSL bridge is unavailable here")
        with tempfile.TemporaryDirectory(prefix="jev-marketplace-test-", dir="/tmp") as directory:
            marketplace = Path(directory) / ".agents/plugins/marketplace.json"
            marketplace.parent.mkdir(parents=True)
            marketplace.write_text(json.dumps({"plugins": [{"name": "codex-jev"},
                                                          {"name": "codex-chime"}]}))
            linux_path = str(marketplace)
            windows_path = subprocess.run(["wslpath", "-w", linux_path],
                                          capture_output=True, text=True, check=True).stdout.strip()
            with mock.patch.dict(os.environ, {"CODEX_JEV_MARKETPLACE_PATH": str(marketplace)}):
                for incoming, name, expected in (
                    (windows_path, "codex-jev", linux_path),
                    (windows_path, "codex-chime", linux_path),
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
            with mock.patch.object(Path, "home", return_value=Path(directory)):
                with mock.patch.dict(os.environ, {"CODEX_JEV_MARKETPLACE_PATH": ""}):
                    self.assertIn(json.dumps(linux_path), patch.marketplace_path_bridge())

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="jev-patch-test-", dir="/tmp")
        self.addCleanup(self.temp.cleanup)
        self.extension = Path(self.temp.name) / f"openai.chatgpt-{patch.VERSION}"
        self.backup = Path(self.temp.name) / "rollback"
        original = {
            "out/extension.js": ("prefix " + patch.ANCHOR + " suffix").encode(),
            "webview/index.html": ("<html>" + patch.MODULE + "</html>").encode(),
            patch.IMAGE_ASSET: ("prefix " + patch.IMAGE_ANCHOR + " suffix").encode(),
        }
        for relative, content in original.items():
            destination = self.extension / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        (self.extension / "webview/assets").mkdir(exist_ok=True)
        self.original = original
        self.digests = {name: hashlib.sha256(value).hexdigest() for name, value in original.items()}
        self.original_patch = mock.patch.object(patch, "ORIGINAL", {
            name: value for name, value in self.digests.items() if name != patch.IMAGE_ASSET})
        self.original_patch.start()
        self.addCleanup(self.original_patch.stop)
        self.image_patch = mock.patch.object(patch, "IMAGE_ORIGINAL", self.digests[patch.IMAGE_ASSET])
        self.image_patch.start()
        self.addCleanup(self.image_patch.stop)

    def test_apply_update_restore_and_tamper_rejection(self):
        patch.apply(self.extension, self.backup)
        manifest_path = self.backup / "manifest.json"
        first = json.loads(manifest_path.read_text())
        self.assertIn("codexJev.bridge", (self.extension / "out/extension.js").read_text())
        self.assertIn("retryConnection", (self.extension / "out/extension.js").read_text())
        self.assertIn("saveApiKey", (self.extension / "out/extension.js").read_text())
        self.assertIn("testApiKey", (self.extension / "out/extension.js").read_text())
        self.assertIn('"openTypeSafe"', (self.extension / "out/extension.js").read_text())
        self.assertIn("settingsSave", (self.extension / "out/extension.js").read_text())
        self.assertIn("searchRelevance:u.searchRelevance", (self.extension / "out/extension.js").read_text())
        self.assertIn("u.searchRelevance.relevant_max>100", (self.extension / "out/extension.js").read_text())
        self.assertIn("logLimitMb:u.logLimitMb", (self.extension / "out/extension.js").read_text())
        self.assertIn("neverDeleteLogs:u.neverDeleteLogs", (self.extension / "out/extension.js").read_text())
        self.assertIn("feature:u.feature", (self.extension / "out/extension.js").read_text())
        self.assertIn("viewId", (self.extension / "out/extension.js").read_text())
        self.assertEqual((self.extension / patch.ASSET).read_bytes(),
                         (SOURCE.parent / "webview/jev-control.js").read_bytes())
        self.assertEqual((self.extension / patch.SETTINGS_ASSET).read_bytes(),
                         (SOURCE.parent / "webview/jev-settings.js").read_bytes())
        self.assertIn(b"jev-settings.js", (self.extension / "webview/index.html").read_bytes())
        self.assertEqual((self.extension / patch.ICON_ASSET).read_bytes(),
                         (SOURCE.parent / "icon.png").read_bytes())
        self.assertIn(b"wsl.localhost", (self.extension / patch.IMAGE_ASSET).read_bytes())

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
        self.assertFalse((self.extension / patch.SETTINGS_ASSET).exists())
        self.assertFalse((self.extension / patch.ICON_ASSET).exists())
        for relative, content in self.original.items():
            self.assertEqual((self.extension / relative).read_bytes(), content)

    def test_update_adds_icon_to_previous_patch(self):
        patch.apply(self.extension, self.backup)
        manifest_path = self.backup / "manifest.json"
        manifest = json.loads(manifest_path.read_text())
        del manifest["patched"][patch.ICON_ASSET]
        del manifest["patched"][patch.SETTINGS_ASSET]
        manifest_path.write_text(json.dumps(manifest))
        (self.extension / patch.ICON_ASSET).unlink()
        (self.extension / patch.SETTINGS_ASSET).unlink()
        patch.update(self.extension, self.backup)
        upgraded = json.loads(manifest_path.read_text())
        self.assertEqual((self.extension / patch.ICON_ASSET).read_bytes(),
                         (SOURCE.parent / "icon.png").read_bytes())
        self.assertIn(patch.ICON_ASSET, upgraded["patched"])
        self.assertIn(patch.SETTINGS_ASSET, upgraded["patched"])
        patch.restore(self.extension, self.backup)
        self.assertFalse((self.extension / patch.ICON_ASSET).exists())
        self.assertFalse((self.extension / patch.SETTINGS_ASSET).exists())


if __name__ == "__main__":
    unittest.main()
