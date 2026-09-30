#!/usr/bin/env python3
"""Fail packaging when the hook, plugin, and control disagree on the hook version."""

import json
from pathlib import Path
import sys
import tomllib

ROOT = Path(__file__).resolve().parents[1]


def check(root: Path = ROOT) -> str:
    cargo = tomllib.loads((root / "rust/jev/Cargo.toml").read_text(encoding="utf-8"))
    plugin = json.loads((root / ".codex-plugin/plugin.json").read_text(encoding="utf-8"))
    control = json.loads((root / "vscode-control/package.json").read_text(encoding="utf-8"))
    hook = cargo["package"]["version"]
    if plugin["version"].split("+", 1)[0] != hook or control["codexJevHookVersion"] != hook:
        raise ValueError("Hook, plugin, and VS Code control versions differ; update all three before packaging")
    return hook


if __name__ == "__main__":
    try:
        print(f"Codex Jev hook version {check()} is consistent.")
    except (OSError, KeyError, ValueError) as error:
        print(f"Codex Jev packaging blocked: {error}", file=sys.stderr)
        raise SystemExit(1) from None
