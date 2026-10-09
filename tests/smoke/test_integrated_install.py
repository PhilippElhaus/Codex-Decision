"""Check safe, repeatable updates of the hook bundled inside the VSIX."""

import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("decision_integrated_install", ROOT / "vscode-control/install-plugin.py")
INSTALLER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALLER)


class IntegratedInstall(unittest.TestCase):
    def setUp(self):
        self.task = tempfile.TemporaryDirectory(prefix="decision-plugin-test-")
        self.root = Path(self.task.name)
        self.home = self.root / "home"
        self.home.mkdir()
        self.codex_home = self.home / ".codex"
        self.payload = self.root / "payload"
        self.source = self.home / "plugins/codex-decision"
        self.current = None
        self.commands = []
        for filename in INSTALLER.FILES:
            target = self.payload / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(json.dumps({"name": "codex-decision", "version": "1.0.0"})
                              if filename == ".codex-plugin/plugin.json" else "bundled " + filename)
            if filename.startswith("hooks/bin/"):
                target.chmod(0o755)

    def tearDown(self):
        self.task.cleanup()

    def existing(self, version="1.0.0"):
        self.current = {"pluginId": "codex-decision@personal", "name": "codex-decision",
                        "marketplaceName": "personal", "version": version, "installed": True,
                        "enabled": True, "source": {"source": "local", "path": str(self.source)}}
        shutil.copytree(self.payload, self.source)
        manifest = self.source / ".codex-plugin/plugin.json"
        manifest.write_text(json.dumps({"name": "codex-decision", "version": version}))
        self.cache()

    def cache(self):
        target = self.codex_home / "plugins/cache" / self.current["marketplaceName"] / "codex-decision" / self.current["version"]
        shutil.copytree(self.source, target, dirs_exist_ok=True)
        return target

    def run_cli(self, _binary, args):
        self.commands.append(args)
        if args == ["list"]:
            return {"installed": [self.current] if self.current else []}
        if args == ["marketplace", "list"]:
            return {"marketplaces": [{"name": "personal", "root": str(self.home)}]}
        if args[:2] == ["marketplace", "add"]:
            return {}
        if args[0] == "add":
            marketplace = args[1].split("@", 1)[1]
            if not self.current:
                self.source = self.home / ".local/share/codex-decision/plugins/codex-decision"
            version = json.loads((self.source / ".codex-plugin/plugin.json").read_text())["version"]
            self.current = {"pluginId": args[1], "name": "codex-decision", "marketplaceName": marketplace,
                            "version": version, "installed": True, "enabled": True,
                            "source": {"source": "local", "path": str(self.source)}}
            self.cache()
            return {}
        self.fail("Unexpected installer command")

    def install(self, **kwargs):
        return INSTALLER.install(self.payload, Path("codex"), self.home, self.codex_home, self.run_cli, **kwargs)

    def test_updates_existing_identity_and_preserves_data_trust_and_unknown_files(self):
        self.existing("0.9.0")
        unknown = self.source / "operator-notes.txt"
        unknown.write_text("preserve")
        state = self.codex_home / "config.toml"
        state.write_text("preserved trust record")
        data = self.codex_home / "plugins/data/codex-decision-personal"
        data.mkdir(parents=True)
        (data / "settings.json").write_text("preserved preferences")
        result = self.install(data_directory=data)
        self.assertEqual(result["pluginId"], "codex-decision@personal")
        self.assertEqual(result["status"], "installed")
        self.assertEqual(unknown.read_text(), "preserve")
        self.assertEqual(state.read_text(), "preserved trust record")
        self.assertEqual((data / "settings.json").read_text(), "preserved preferences")
        backup = Path(result["rollback"]) / ".codex-plugin/plugin.json"
        self.assertEqual(json.loads(backup.read_text())["version"], "0.9.0")
        self.assertFalse(any(args[:2] == ["marketplace", "add"] for args in self.commands))

    def test_repeat_install_does_not_reinstall_or_change_choices(self):
        self.existing()
        result = self.install()
        self.assertEqual(result["status"], "ready")
        self.assertFalse(any(args[0] == "add" for args in self.commands))

    def test_same_version_source_and_cache_damage_is_repaired(self):
        self.existing()
        (self.source / "hooks/hooks.json").write_text("outdated source")
        self.install()
        self.commands.clear()
        (self.cache() / "skills/decision-output/SKILL.md").write_text("damaged cache")
        self.install()
        self.assertIn(["add", "codex-decision@personal"], self.commands)
        self.assertEqual((self.cache() / "skills/decision-output/SKILL.md").read_bytes(),
                         (self.payload / "skills/decision-output/SKILL.md").read_bytes())

    def test_mismatched_data_directory_is_rejected_before_source_update(self):
        self.existing("0.9.0")
        before = (self.source / ".codex-plugin/plugin.json").read_bytes()
        with self.assertRaisesRegex(ValueError, "dataDirectory does not match"):
            self.install(data_directory=self.home / "different-data")
        self.assertEqual((self.source / ".codex-plugin/plugin.json").read_bytes(), before)
        self.assertFalse(any(args[0] == "add" for args in self.commands))

    def test_fresh_install_creates_one_managed_marketplace(self):
        result = self.install()
        self.assertEqual(result["pluginId"], "codex-decision@codex-decision-integrated")
        self.assertEqual(sum(args[0] == "add" for args in self.commands), 1)
        manifest = self.home / ".local/share/codex-decision/.agents/plugins/marketplace.json"
        self.assertEqual(json.loads(manifest.read_text())["name"], "codex-decision-integrated")
        self.assertEqual(result["marketplacePath"], str(manifest))

    def test_linked_source_and_development_repository_are_rejected(self):
        self.existing()
        target = self.source / "hooks/hooks.json"
        target.unlink()
        target.symlink_to(self.payload / "hooks/hooks.json")
        with self.assertRaisesRegex(ValueError, "symbolic links"):
            self.install()
        target.unlink()
        target.write_bytes((self.payload / "hooks/hooks.json").read_bytes())
        (self.source / ".git").mkdir()
        with self.assertRaisesRegex(ValueError, "development repository"):
            self.install()

    def test_existing_newer_version_is_not_downgraded(self):
        self.existing("2.0.0")
        with self.assertRaisesRegex(ValueError, "newer than"):
            self.install()
        self.assertFalse(any(args[0] == "add" for args in self.commands))

    def test_existing_disabled_registration_is_preserved(self):
        self.existing("0.9.0")
        self.current["enabled"] = False
        with self.assertRaisesRegex(ValueError, "disabled in Codex"):
            self.install()
        self.assertFalse(self.current["enabled"])
        self.assertFalse(any(args[0] == "add" for args in self.commands))

    def test_existing_managed_marketplace_collision_is_rejected_before_writes(self):
        original = self.run_cli
        def run(_binary, args):
            if args == ["marketplace", "list"]:
                return {"marketplaces": [{"name": "codex-decision-integrated", "root": str(self.home / "unknown")}]}
            return original(_binary, args)
        with self.assertRaisesRegex(ValueError, "already registered"):
            INSTALLER.install(self.payload, Path("codex"), self.home, self.codex_home, run)
        self.assertFalse((self.home / ".local/share/codex-decision").exists())


if __name__ == "__main__":
    unittest.main()
