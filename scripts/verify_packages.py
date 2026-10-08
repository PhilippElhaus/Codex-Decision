"""Check exact release contents, source bytes, versions, and binary targets."""

import argparse
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parents[1]
PLUGIN_FILES = (
    ".codex-plugin/plugin.json", "skills/decision-output/SKILL.md", "hooks/hooks.json",
    "hooks/bin/linux-x86_64/decision-hook", "hooks/bin/linux-x86_64/decisionctl",
    "assets/logo.png", "assets/icon.png", "config.example.json", "LICENSE",
)
CONTROL_FILES = (
    "config-contract.json", "core.js", "extension.js", "icon.png", "package.json",
    "panel-state.js", "panel.js", "schema.js", "providers.js", "private-paths.js", "private-records.js", "publication-journal.js", "media/decision-panel.svg",
    "webview/decision-control.js", "webview/decision-panel.css", "webview/decision-panel.js",
    "webview/decision-totals.js",
    "webview/decision-settings.js",
)


def check_entries(archive, expected):
    names = archive.namelist()
    if len(names) != len(set(names)) or set(names) != set(expected):
        raise ValueError("Archive contents differ from the release allowlist")
    if sum(item.file_size for item in archive.infolist()) > 100_000_000:
        raise ValueError("Archive exceeds the uncompressed size limit")


def check_bytes(archive, mapping, root):
    for archived, source in mapping.items():
        path = root / source
        if path.is_symlink() or archive.read(archived) != path.read_bytes():
            raise ValueError(f"Packaged file differs from source: {source}")


def check_elf(data):
    if len(data) < 64 or data[:6] != b"\x7fELF\x02\x01" or data[18:20] != b"\x3e\x00":
        raise ValueError("Package requires Linux x86_64 ELF binaries")


def verify_plugin(path, root=ROOT):
    mapping = {f"codex-decision/{name}": name for name in PLUGIN_FILES}
    with zipfile.ZipFile(path) as archive:
        check_entries(archive, mapping)
        check_bytes(archive, mapping, root)
        manifest = json.loads(archive.read("codex-decision/.codex-plugin/plugin.json"))
        control = json.loads((root / "vscode-control/package.json").read_text())
        if manifest["name"] != "codex-decision" or manifest["version"].split("+", 1)[0] != control["codexDecisionHookVersion"]:
            raise ValueError("Plugin and control hook versions differ")
        for binary in ("decision-hook", "decisionctl"):
            name = f"codex-decision/hooks/bin/linux-x86_64/{binary}"
            data = archive.read(name)
            check_elf(data)
            if binary == "decision-hook" and b"CODEX_DECISION_TEST_ENDPOINT" in data:
                raise ValueError("Production package contains a verification hook")
            if not (archive.getinfo(name).external_attr >> 16) & 0o111:
                raise ValueError(f"Packaged binary is not executable: {binary}")


def verify_control(path, root=ROOT):
    mapping = {f"extension/{name}": f"vscode-control/{name}" for name in CONTROL_FILES}
    mapping.update({"extension/LICENSE.txt": "vscode-control/LICENSE",
                    "extension/readme.md": "vscode-control/README.md"})
    with zipfile.ZipFile(path) as archive:
        check_entries(archive, {*mapping, "extension.vsixmanifest", "[Content_Types].xml"})
        check_bytes(archive, mapping, root)
        package = json.loads(archive.read("extension/package.json"))
        identity = ET.fromstring(archive.read("extension.vsixmanifest")).find(".//{*}Identity")
        if identity is None or identity.get("Version") != package["version"] or identity.get("Publisher") != package["publisher"]:
            raise ValueError("VSIX identity differs from the control package")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--plugin", type=Path)
    parser.add_argument("--vsix", type=Path)
    args = parser.parse_args()
    if not args.plugin and not args.vsix:
        parser.error("provide --plugin or --vsix")
    for archive, verify in ((args.plugin, verify_plugin), (args.vsix, verify_control)):
        if archive:
            verify(archive)
            print(f"Verified {archive.name}: exact contents and source bytes")


if __name__ == "__main__":
    main()
