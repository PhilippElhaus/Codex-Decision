"""Bounded rollback of versioned plugin caches used by active Codex threads."""

import json
import os
from pathlib import Path
import stat
import tempfile
import time


MAX_VERSIONS = 32
MAX_ENTRIES = 4096
MAX_FILE_BYTES = 32 * 1024 * 1024
MAX_CACHE_BYTES = 512 * 1024 * 1024


def sensitive(name):
    name = name.lower()
    return (name == ".env" or name.startswith(".env.") or
            name in {"auth.json", "id_rsa", "id_ed25519"} or
            name.startswith(("credentials", "credential", "token")) or
            name.endswith((".key", ".p12", ".pfx")))


def tree(root, safe_path):
    root = safe_path(root)
    files, directories = {}, {}
    if not root.exists():
        return files, directories
    if not root.is_dir():
        raise ValueError("Decision cache directory is invalid")
    directories[""] = root.stat().st_mode & 0o777
    total = 0
    for directory, names, filenames in os.walk(root, followlinks=False):
        for name in (*names, *filenames):
            if sensitive(name):
                raise ValueError("Decision cache contains private state; preserve it before updating")
            target = safe_path(Path(directory) / name)
            relative = target.relative_to(root).as_posix()
            info = target.lstat()
            if len(target.relative_to(root).parts) > 32:
                raise ValueError("Decision cache rollback exceeds its depth limit")
            if stat.S_ISDIR(info.st_mode):
                directories[relative] = info.st_mode & 0o777
            elif stat.S_ISREG(info.st_mode):
                if info.st_size > MAX_FILE_BYTES:
                    raise ValueError("Decision cache rollback exceeds its file size limit")
                files[relative] = info
                total += info.st_size
            else:
                raise ValueError("Decision cache contains an unsupported file type")
            if len(files) + len(directories) > MAX_ENTRIES or total > MAX_CACHE_BYTES:
                raise ValueError("Decision cache rollback exceeds its size limit")
    return files, directories


def read_file(path, expected, safe_path):
    descriptor = os.open(safe_path(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(descriptor, "rb") as stream:
        info = os.fstat(stream.fileno())
        if not stat.S_ISREG(info.st_mode) or (info.st_dev, info.st_ino, info.st_size) != (
                expected.st_dev, expected.st_ino, expected.st_size):
            raise ValueError("Decision cache changed during inspection")
        data = stream.read(MAX_FILE_BYTES + 1)
    if len(data) != expected.st_size:
        raise ValueError("Decision cache changed during inspection")
    return data


def snapshot(cache_root, safe_path, version_tuple, plugin):
    cache_root = safe_path(cache_root)
    if not cache_root.exists():
        return {}
    if not cache_root.is_dir():
        raise ValueError("Decision cache directory is invalid")
    pending, total, entries = {}, 0, 0
    for directory in cache_root.iterdir():
        version_tuple(directory.name)
        files, directories = tree(directory, safe_path)
        pending[directory.name] = (files, directories)
        total += sum(info.st_size for info in files.values())
        entries += len(files) + len(directories)
        if len(pending) > MAX_VERSIONS or total > MAX_CACHE_BYTES or entries > MAX_ENTRIES:
            raise ValueError("Decision cache rollback exceeds its size limit")
    # Validate the complete tree before reading any cache payload.
    snapshots = {}
    for old_version, (files, directories) in pending.items():
        manifest_name = ".codex-plugin/plugin.json"
        if manifest_name not in files or files[manifest_name].st_size > 128_000:
            raise ValueError("A Decision cache directory has inconsistent ownership")
        manifest = json.loads(read_file(cache_root / old_version / manifest_name,
                                        files[manifest_name], safe_path))
        if not isinstance(manifest, dict) or manifest.get("name") != plugin or manifest.get("version") != old_version:
            raise ValueError("A Decision cache directory has inconsistent ownership")
        snapshots[old_version] = {
            "files": {name: read_file(cache_root / old_version / name, info, safe_path)
                      for name, info in files.items()},
            "modes": {name: info.st_mode & 0o777 for name, info in files.items()},
            "directories": directories,
        }
    return snapshots


def save(snapshots, backup_root, cache_root, source, safe_path, write_exact):
    if not snapshots:
        return None
    backup_root = safe_path(backup_root)
    backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    rollback = Path(tempfile.mkdtemp(prefix=f"{int(time.time())}-", dir=backup_root))
    metadata = {"cacheRoot": str(cache_root), "versions": {}}
    for old_version, state in snapshots.items():
        for name, data in state["files"].items():
            write_exact(rollback / "cache" / old_version / name, data)
        metadata["versions"][old_version] = {"modes": state["modes"], "directories": state["directories"]}
    write_exact(rollback / "cache-state.json", json.dumps(metadata).encode())
    write_exact(rollback / "source.json", json.dumps({"source": str(source)}).encode())
    return str(rollback)


def restore(cache_root, snapshots, target_version, safe_path):
    for old_version, state in snapshots.items():
        if old_version == target_version:
            continue
        root = safe_path(cache_root / old_version)
        files, directories = tree(root, safe_path)
        if (any(name not in state["files"] or read_file(root / name, info, safe_path) != state["files"][name]
                or info.st_mode & 0o777 != state["modes"][name] for name, info in files.items()) or
                any(name not in state["directories"] or mode != state["directories"][name]
                    for name, mode in directories.items())):
            raise RuntimeError("An active Decision cache changed during installation; its rollback was retained")
        created_directories = []
        for name in state["directories"]:
            if name in directories:
                continue
            target = safe_path(root / name)
            try:
                target.mkdir(parents=not name)
                created_directories.append(name)
            except FileExistsError:
                target = safe_path(target)
                if not target.is_dir() or target.stat().st_mode & 0o777 != state["directories"][name]:
                    raise RuntimeError("An active Decision cache changed during installation; its rollback was retained") from None
        for name, data in state["files"].items():
            if name not in files:
                target = safe_path(root / name)
                try:
                    descriptor = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, state["modes"][name])
                except FileExistsError:
                    info = safe_path(target).lstat()
                    if (not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE_BYTES or
                            info.st_mode & 0o777 != state["modes"][name] or read_file(target, info, safe_path) != data):
                        raise RuntimeError("An active Decision cache changed during installation; its rollback was retained") from None
                    continue
                with os.fdopen(descriptor, "wb") as stream:
                    stream.write(data)
                    stream.flush()
                    os.fchmod(stream.fileno(), state["modes"][name])
                    os.fsync(stream.fileno())
        for name in reversed(created_directories):
            os.chmod(safe_path(root / name), state["directories"][name])
