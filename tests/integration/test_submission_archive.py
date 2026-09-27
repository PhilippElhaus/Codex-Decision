"""Exercise the public upload ZIP as an installed local plugin."""

from contextlib import redirect_stdout
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock
from zipfile import ZipFile


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("build_submission", ROOT / "scripts/build_submission.py")
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


class SubmissionArchiveTests(unittest.TestCase):
    def test_zip_contains_installable_hook_and_no_private_or_ui_files(self):
        with redirect_stdout(io.StringIO()):
            builder.main()
        archive_path = ROOT / ".local/submission/codex-jev-0.3.0.zip"
        self.assertLess(archive_path.stat().st_size, 100_000_000)
        with tempfile.TemporaryDirectory(prefix="jev-submission-test-", dir="/tmp") as directory:
            destination = Path(directory)
            with ZipFile(archive_path) as archive:
                self.assertIsNone(archive.testzip())
                names = archive.namelist()
                self.assertIn("codex-jev/skills/jev-output/SKILL.md", names)
                self.assertIn("codex-jev/hooks/post_tool_use.py", names)
                self.assertIn("codex-jev/hooks/hooks.json", names)
                self.assertTrue(all(name.startswith("codex-jev/") and
                                    ".." not in Path(name).parts and
                                    stat.S_IFMT(archive.getinfo(name).external_attr >> 16) == stat.S_IFREG
                                    for name in names))
                self.assertFalse(any(name.endswith((".env", ".vsix", ".svg")) or
                                     "/docs/images/" in name or "/apps/" in name for name in names))
                manifest = json.loads(archive.read("codex-jev/.codex-plugin/plugin.json"))
                self.assertEqual(manifest["skills"], "./skills/")
                self.assertNotIn("screenshots", manifest["interface"])
                archive.extractall(destination)

            plugin = destination / "codex-jev"
            data = destination / "data"
            data.mkdir()
            (data / "config.json").write_text("{}", encoding="utf-8")
            event = {"hook_event_name": "PostToolUse", "tool_name": "Bash",
                     "tool_input": {"command": "printf done"}, "tool_response": "done\n"}
            process = subprocess.run(
                [sys.executable, str(plugin / "hooks/post_tool_use.py")],
                input=json.dumps(event), capture_output=True, text=True, timeout=10,
                env={**os.environ, "PLUGIN_ROOT": str(plugin), "PLUGIN_DATA": str(data)},
                check=True,
            )
            self.assertEqual(process.stdout, "{}\n")
            self.assertEqual(process.stderr, "")

    def test_builder_rejects_linked_directory_and_path_escape(self):
        with tempfile.TemporaryDirectory(prefix="jev-submission-edge-", dir="/tmp") as directory:
            root = Path(directory) / "plugin"
            root.mkdir()
            manifest = root / ".codex-plugin/plugin.json"
            manifest.parent.mkdir()
            manifest.write_text(json.dumps({
                "name": "codex-jev", "version": "0.3.0", "skills": "./skills/",
                "interface": {"shortDescription": "Trim repetitive tool output"},
            }), encoding="utf-8")
            external = Path(directory) / "external"
            external.mkdir()
            (external / "SKILL.md").write_text("synthetic skill", encoding="utf-8")
            (root / "skills").symlink_to(external, target_is_directory=True)
            with mock.patch.object(builder, "ROOT", root), mock.patch.object(
                builder, "FILES", (".codex-plugin/plugin.json", "skills/SKILL.md")
            ), redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, "linked submission file"):
                    builder.main()
            with mock.patch.object(builder, "ROOT", root), mock.patch.object(
                builder, "FILES", (".codex-plugin/plugin.json", "../external/SKILL.md")
            ), redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(ValueError, "Unsafe submission path"):
                    builder.main()


if __name__ == "__main__":
    unittest.main()
