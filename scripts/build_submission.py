#!/usr/bin/env python3
"""Build the minimal Codex Jev Skills-only submission ZIP."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import stat
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


ROOT = Path(__file__).resolve().parents[1]
FILES = (
    ".codex-plugin/plugin.json",
    "skills/jev-output/SKILL.md",
    "hooks/hooks.json",
    "hooks/post_tool_use.py",
    "hooks/jev.py",
    "hooks/evidence.py",
    "hooks/test_build.py",
    "hooks/search_listing.py",
    "hooks/receipts.py",
    "scripts/configure_key.py",
    "assets/logo.png",
    "assets/icon.png",
    "config.example.json",
    "docs/architecture/design_data.md",
    "LICENSE",
)


def main() -> None:
    manifest = json.loads((ROOT / FILES[0]).read_text(encoding="utf-8"))
    name = manifest["name"]
    version = manifest["version"]
    if name != "codex-jev" or not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("Expected codex-jev with a stable semantic version")
    if manifest.get("skills") != "./skills/":
        raise ValueError("The submission needs the root skills directory")
    interface = manifest["interface"]
    if any(key in manifest for key in ("apps", "mcpServers")) or "screenshots" in interface:
        raise ValueError("Skills-only submissions cannot declare MCP apps or screenshots")
    if len(interface["shortDescription"]) > 30:
        raise ValueError("Public short description exceeds 30 characters")

    destination = ROOT / ".local" / "submission" / f"{name}-{version}.zip"
    destination.parent.mkdir(parents=True, exist_ok=True)
    with ZipFile(destination, "w", compression=ZIP_DEFLATED, compresslevel=9) as archive:
        for relative in FILES:
            source = ROOT / relative
            components = Path(relative).parts
            if Path(relative).is_absolute() or ".." in components:
                raise ValueError(f"Unsafe submission path: {relative}")
            parents = [ROOT.joinpath(*components[:index]) for index in range(1, len(components) + 1)]
            if (not source.is_file() or
                    any(path.is_symlink() for path in parents) or
                    not source.resolve().is_relative_to(ROOT.resolve())):
                raise ValueError(f"Missing or linked submission file: {relative}")
            entry = ZipInfo(f"{name}/{relative}", date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = ZIP_DEFLATED
            entry.external_attr = (stat.S_IFREG | 0o644) << 16
            archive.writestr(entry, source.read_bytes(), compress_type=ZIP_DEFLATED, compresslevel=9)
    with ZipFile(destination) as archive:
        if archive.testzip() is not None or len(archive.namelist()) != len(FILES):
            raise ValueError("Submission ZIP failed integrity checks")
    if destination.stat().st_size > 100_000_000:
        raise ValueError("Submission ZIP exceeds the 100 MB portal limit")
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    print(f"{destination}\nSHA-256 {digest}\n{len(FILES)} allowlisted files")


if __name__ == "__main__":
    main()
