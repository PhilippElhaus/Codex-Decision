"""Copy legacy Jev plugin data to the Codex Jev ID without removing originals."""

from __future__ import annotations

import filecmp
import os
from pathlib import Path
import shutil
import stat


DATA_ROOT = Path.home() / ".codex" / "plugins" / "data"
LEGACY = DATA_ROOT / "codex-jev-output-pilot-personal"
CURRENT = DATA_ROOT / "codex-jev-personal"


def _regular(path: Path) -> bool:
    return stat.S_ISREG(path.lstat().st_mode)


def _directory(path: Path) -> bool:
    return stat.S_ISDIR(path.lstat().st_mode)


def _copy_file(source: Path, target: Path) -> bool:
    if not _regular(source):
        raise ValueError(f"Legacy data contains a linked or non-regular file: {source}")
    if target.exists() or target.is_symlink():
        if not _regular(target) or not filecmp.cmp(source, target, shallow=False):
            raise ValueError(f"Codex Jev data already differs: {target}")
        return False
    with source.open("rb") as reader:
        descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "wb") as writer:
            shutil.copyfileobj(reader, writer)
    return True


def migrate(source: Path = LEGACY, target: Path = CURRENT) -> dict[str, int]:
    if not source.exists() and not source.is_symlink():
        return {"copied": 0, "already_present": 0}
    if not _directory(source):
        raise ValueError("Legacy Jev data directory is a link or not a directory")
    if target.exists() or target.is_symlink():
        if not _directory(target):
            raise ValueError("Codex Jev data directory is a link or not a directory")
    else:
        target.mkdir(mode=0o700)
    counts = {"copied": 0, "already_present": 0}
    for name in ("config.json", "events.jsonl"):
        old = source / name
        if old.exists() or old.is_symlink():
            counts["copied" if _copy_file(old, target / name) else "already_present"] += 1
    old_outputs = source / "outputs"
    if old_outputs.exists() or old_outputs.is_symlink():
        if not _directory(old_outputs):
            raise ValueError("Legacy outputs directory is a link or not a directory")
        new_outputs = target / "outputs"
        if new_outputs.exists() or new_outputs.is_symlink():
            if not _directory(new_outputs):
                raise ValueError("Codex Jev outputs directory is a link or not a directory")
        else:
            new_outputs.mkdir(mode=0o700)
        for session in old_outputs.iterdir():
            if not _directory(session):
                raise ValueError(f"Legacy outputs contain a link or non-directory: {session}")
            destination = new_outputs / session.name
            if destination.exists() or destination.is_symlink():
                if not _directory(destination):
                    raise ValueError(f"Codex Jev output directory is unsafe: {destination}")
            else:
                destination.mkdir(mode=0o700)
            for original in session.iterdir():
                counts["copied" if _copy_file(original, destination / original.name) else "already_present"] += 1
    return counts


if __name__ == "__main__":
    print(migrate())
