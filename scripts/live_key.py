"""Copy the installed .env into private disposable data for live smoke runs."""

from __future__ import annotations

import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "hooks"))
from jev import load_api_key  # noqa: E402


def copy_key(data_dir: Path) -> None:
    source = os.environ.get("CODEX_JEV_DATA_DIRECTORY")
    if not source:
        raise RuntimeError("Set CODEX_JEV_DATA_DIRECTORY to the installed PLUGIN_DATA path for live runs")
    key = load_api_key(Path(source))
    target = data_dir / ".env"
    with open(target, "x", encoding="utf-8", opener=lambda path, flags: os.open(path, flags, 0o600)) as file:
        file.write(f"JEV_API_KEY={key}\n")
