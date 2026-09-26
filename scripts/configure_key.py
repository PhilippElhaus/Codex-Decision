#!/usr/bin/env python3
"""Store a Jev API key in the installed plugin data directory."""

from __future__ import annotations

import argparse
from getpass import getpass
import os
from pathlib import Path
import re
import stat
import tempfile


def save_key(data_dir: Path, key: str) -> Path:
    if not 8 <= len(key) <= 4096 or re.search(r"\s|\x00", key):
        raise ValueError("Jev API key is missing or invalid")
    if data_dir.is_symlink():
        raise ValueError("Plugin data directory is a link")
    data_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if not data_dir.is_dir():
        raise ValueError("Plugin data path is not a directory")
    target = data_dir / ".env"
    if target.is_symlink() or (target.exists() and not target.is_file()):
        raise ValueError("Jev credential path is unsafe")
    handle, temporary = tempfile.mkstemp(prefix=".jev-key-", dir=data_dir)
    try:
        if hasattr(os, "fchmod"):
            os.fchmod(handle, stat.S_IRUSR | stat.S_IWUSR)
        with os.fdopen(handle, "w", encoding="utf-8") as file:
            file.write(f"JEV_API_KEY={key}\n")
            file.flush()
            os.fsync(file.fileno())
        os.replace(temporary, target)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, default=os.environ.get("CODEX_JEV_DATA_DIRECTORY"),
                        help="installed PLUGIN_DATA directory; or set CODEX_JEV_DATA_DIRECTORY")
    args = parser.parse_args()
    if args.data_dir is None or not args.data_dir.is_absolute():
        parser.error("provide an absolute --data-dir or CODEX_JEV_DATA_DIRECTORY")
    save_key(args.data_dir, getpass("Jev API key: "))
    print("Jev API key saved in plugin data.")


if __name__ == "__main__":
    main()
