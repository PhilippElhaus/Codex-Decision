"""Reject stale, extra, duplicate, and wrongly targeted release files."""

from pathlib import Path
import os
import subprocess
import tempfile
import unittest
import zipfile

from scripts.verify_packages import PLUGIN_FILES, verify_plugin


ROOT = Path(__file__).resolve().parents[2]


class PackageTests(unittest.TestCase):
    def test_plugin_contents_target_and_source_bytes(self):
        with tempfile.TemporaryDirectory(prefix="jev-package-") as directory:
            root = Path(directory)
            for name in PLUGIN_FILES:
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((ROOT / name).read_bytes())
            control = root / "vscode-control/package.json"
            control.parent.mkdir()
            control.write_bytes((ROOT / "vscode-control/package.json").read_bytes())

            def archive(extra=False, changed=False):
                path = root / "fixture.zip"
                with zipfile.ZipFile(path, "w") as output:
                    for name in PLUGIN_FILES:
                        data = (root / name).read_bytes()
                        if changed and name == "LICENSE":
                            data += b"stale"
                        info = zipfile.ZipInfo("codex-decision/" + name)
                        info.external_attr = 0o100755 << 16
                        output.writestr(info, data)
                    if extra:
                        output.writestr("codex-decision/unexpected.txt", b"fixture")
                return path

            verify_plugin(archive(), root)
            with self.assertRaisesRegex(ValueError, "allowlist"):
                verify_plugin(archive(extra=True), root)
            with self.assertRaisesRegex(ValueError, "differs from source"):
                verify_plugin(archive(changed=True), root)
            # The source and archive agree, but both carry the wrong target.
            binary = root / "hooks/bin/linux-x86_64/decision-hook"
            data = binary.read_bytes()
            binary.write_bytes(data + b"CODEX_DECISION_TEST_ENDPOINT")
            with self.assertRaisesRegex(ValueError, "verification hook"):
                verify_plugin(archive(), root)
            binary.write_bytes(data[:18] + b"\xb7\x00" + data[20:])
            with self.assertRaisesRegex(ValueError, "Linux x86_64"):
                verify_plugin(archive(), root)

    def test_submission_rejects_unsupported_host_before_cargo(self):
        # Some Lab data mounts are noexec. Keep this executable fixture in an
        # explicitly selected build cache there, without moving payload data.
        with tempfile.TemporaryDirectory(prefix="jev-target-",
                                         dir=os.environ.get("CODEX_DECISION_TEST_EXECUTABLE_TMP_ROOT")) as directory:
            tool = Path(directory) / "uname"
            tool.write_text('#!/bin/sh\ncase "$1" in -s) echo Darwin;; -m) echo arm64;; esac\n')
            tool.chmod(0o755)
            # Refuse a broken fixture before shell PATH lookup can silently
            # fall back to the real uname and start a production build.
            simulated = subprocess.run([str(tool), "-s"], capture_output=True, text=True)
            self.assertEqual(simulated.returncode, 0)
            self.assertEqual(simulated.stdout.strip(), "Darwin")
            environment = {**os.environ, "PATH": directory + os.pathsep + os.environ["PATH"]}
            result = subprocess.run([str(ROOT / "scripts/build_submission.sh")], env=environment,
                                    capture_output=True, text=True)
            self.assertEqual(result.returncode, 2)
            self.assertIn("require Linux x86_64", result.stderr)


if __name__ == "__main__":
    unittest.main()
