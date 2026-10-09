"""Install the VSIX's hook payload through Codex without changing private state."""

import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


PLUGIN = "codex-decision"
FILES = (
    ".codex-plugin/plugin.json", "skills/decision-output/SKILL.md", "hooks/hooks.json",
    "hooks/bin/linux-x86_64/decision-hook", "hooks/bin/linux-x86_64/decisionctl",
    "assets/logo.png", "assets/icon.png", "config.example.json", "LICENSE",
)


def safe_path(path):
    path = Path(os.path.abspath(path))
    for item in (*reversed(path.parents), path):
        if item.is_symlink():
            raise ValueError("Decision installation paths must not contain symbolic links")
    return path


def read_json(path):
    path = safe_path(path)
    if not path.is_file() or path.stat().st_size > 128_000:
        raise ValueError("Invalid Decision package metadata")
    return json.loads(path.read_text())


def version_tuple(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d+\.\d+\.\d+(?:\+[A-Za-z0-9.-]+)?", value):
        raise ValueError("Invalid Decision package version")
    return tuple(map(int, value.split("+", 1)[0].split(".")))


def run_codex(binary, args):
    completed = subprocess.run([str(binary), "plugin", *args, "--json"],
                               capture_output=True, text=True, timeout=90, check=False)
    if completed.returncode:
        # CLI errors can include unrelated configuration. Keep them out of the UI.
        raise RuntimeError("Codex plugin command failed: " + " ".join(args[:2]))
    if len(completed.stdout) > 2_000_000:
        raise RuntimeError("Codex plugin metadata exceeds the installation limit")
    return json.loads(completed.stdout)


def existing_plugin(metadata):
    installed = [item for item in metadata.get("installed", [])
                 if item.get("name") == PLUGIN and item.get("installed") is True]
    enabled = [item for item in installed if item.get("enabled") is True]
    if len(enabled) > 1 or not enabled and len(installed) > 1:
        raise ValueError("Multiple Decision registrations need an explicit selection")
    return (enabled or installed or [None])[0]


def write_exact(path, data, executable=False):
    path = safe_path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    safe_path(path.parent)
    if path.exists() and not path.is_file():
        raise ValueError("Invalid Decision package destination")
    descriptor, temporary = tempfile.mkstemp(prefix=".decision-install-", dir=path.parent)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
            os.fchmod(stream.fileno(), 0o755 if executable else 0o644)
        safe_path(path)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def update_source(payload, source, backup_root):
    source = safe_path(source)
    if source.exists() and not source.is_dir() or any((root / ".git").exists() for root in (source, *source.parents)):
        raise ValueError("Decision cannot overwrite a development repository")
    changed = []
    for filename in FILES:
        incoming = safe_path(payload / filename)
        target = safe_path(source / filename)
        if not incoming.is_file():
            raise ValueError("The Decision VSIX has an incomplete hook payload")
        if target.exists() and not target.is_file():
            raise ValueError("Invalid Decision package destination")
        if not target.exists() or target.read_bytes() != incoming.read_bytes() or (
                filename.startswith("hooks/bin/") and not target.stat().st_mode & 0o111):
            changed.append(filename)
    if not changed:
        return False, None
    rollback = None
    for filename in changed:
        target = source / filename
        if target.exists():
            if rollback is None:
                backup_root = safe_path(backup_root)
                backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
                rollback = Path(tempfile.mkdtemp(prefix=f"{int(time.time())}-", dir=backup_root))
                write_exact(rollback / "source.json", json.dumps({"source": str(source)}).encode())
            write_exact(rollback / filename, target.read_bytes(), filename.startswith("hooks/bin/"))
        write_exact(target, (payload / filename).read_bytes(), filename.startswith("hooks/bin/"))
    return True, str(rollback) if rollback else None


def install(payload, codex, home=None, codex_home=None, run=run_codex, data_directory=None):
    home = safe_path(home or Path.home())
    codex_home = safe_path(codex_home or os.environ.get("CODEX_HOME", home / ".codex"))
    payload = safe_path(payload)
    for root in [home, codex_home]:
        if str(root) == "/mnt/d" or str(root).startswith("/mnt/d/"):
            raise ValueError("Decision installation state must remain outside D:")
    for filename in FILES:
        if not safe_path(payload / filename).is_file():
            raise ValueError("The Decision VSIX has an incomplete hook payload")
    manifest = read_json(payload / ".codex-plugin/plugin.json")
    if manifest.get("name") != PLUGIN:
        raise ValueError("Invalid Decision hook payload")
    version = manifest.get("version")
    expected_version = version_tuple(version)
    current = existing_plugin(run(codex, ["list"]))
    registration_needed = current is None
    if current:
        if current.get("enabled") is not True:
            raise ValueError("Decision is disabled in Codex; enable its existing registration before repair")
        if version_tuple(current.get("version")) > expected_version:
            raise ValueError("Installed Decision hook is newer than this VSIX")
        source_info = current.get("source", {})
        if source_info.get("source") != "local" or not isinstance(source_info.get("path"), str):
            raise ValueError("This Decision registration needs a local marketplace for integrated updates")
        source = safe_path(source_info["path"])
        if not source.is_relative_to(home) or source == home or source == codex_home:
            raise ValueError("Decision needs a dedicated local package directory under the Linux user home")
        if read_json(source / ".codex-plugin/plugin.json").get("name") != PLUGIN:
            raise ValueError("The registered Decision source is not a Decision package")
        marketplace = current.get("marketplaceName")
        if not isinstance(marketplace, str) or not re.fullmatch(r"[A-Za-z0-9_-]+", marketplace):
            raise ValueError("Invalid Decision marketplace identity")
        plugin_id = f"{PLUGIN}@{marketplace}"
        if current.get("pluginId") != plugin_id:
            raise ValueError("Invalid Decision plugin identity")
        roots = run(codex, ["marketplace", "list"]).get("marketplaces", [])
        registered = [item.get("root") for item in roots if item.get("name") == marketplace]
        marketplace_path = str(safe_path(registered[0]) / ".agents/plugins/marketplace.json") if len(registered) == 1 and isinstance(registered[0], str) else None
    else:
        marketplace = "codex-decision-integrated"
        plugin_id = f"{PLUGIN}@{marketplace}"
        marketplace_root = safe_path(home / ".local/share/codex-decision")
        roots = run(codex, ["marketplace", "list"]).get("marketplaces", [])
        same_named = [item.get("root") for item in roots if item.get("name") == marketplace]
        if same_named and (len(same_named) != 1 or not isinstance(same_named[0], str) or
                           safe_path(same_named[0]) != marketplace_root):
            raise ValueError("Decision integrated marketplace name is already registered at another directory")
        source = marketplace_root / "plugins/codex-decision"
        path = marketplace_root / ".agents/plugins/marketplace.json"
        marketplace_path = str(path)
        metadata = {"name": marketplace, "interface": {"displayName": "Codex Decision"},
                    "plugins": [{"name": PLUGIN, "source": {"source": "local", "path": "./plugins/codex-decision"},
                                 "policy": {"installation": "AVAILABLE", "authentication": "ON_INSTALL"},
                                 "category": "Productivity"}]}
        if path.exists() and read_json(path) != metadata:
            raise ValueError("Decision integrated marketplace contains unknown configuration")
    expected_data_directory = codex_home / "plugins/data" / f"{PLUGIN}-{marketplace}"
    if data_directory and safe_path(data_directory) != expected_data_directory:
        raise ValueError("Decision dataDirectory does not match the active Codex plugin; correct it before repair")
    # Keep generated installation state and rollback files off curated Windows workspaces.
    for root in [source, codex_home]:
        if str(root) == "/mnt/d" or str(root).startswith("/mnt/d/"):
            raise ValueError("Decision installation state must remain outside D:")
    backup_root = safe_path(home / ".local/state/codex-decision/integrated-rollbacks")
    changed, rollback = update_source(payload, source, backup_root)
    if registration_needed:
        write_exact(path, (json.dumps(metadata, indent=2) + "\n").encode())
        run(codex, ["marketplace", "add", str(marketplace_root)])
    installed = safe_path(codex_home / "plugins/cache" / marketplace / PLUGIN / version)
    cache_matches = all(safe_path(installed / filename).is_file() and
                        (installed / filename).read_bytes() == (payload / filename).read_bytes() and
                        (not filename.startswith("hooks/bin/") or (installed / filename).stat().st_mode & 0o111)
                        for filename in FILES)
    refreshed = registration_needed or changed or not cache_matches or current.get("version") != version
    if refreshed:
        run(codex, ["add", plugin_id])
    selected = existing_plugin(run(codex, ["list"]))
    if not selected or selected.get("pluginId") != plugin_id or selected.get("version") != version or selected.get("enabled") is not True:
        raise RuntimeError("Codex did not activate the packaged Decision version")
    for filename in FILES:
        target = safe_path(installed / filename)
        if not target.is_file() or target.read_bytes() != (payload / filename).read_bytes():
            raise RuntimeError("Codex cached Decision package differs from the VSIX")
    return {"status": "installed" if refreshed else "ready", "pluginId": plugin_id,
            "version": version, "pluginRoot": str(installed),
            "dataDirectory": str(expected_data_directory),
            "decisionctl": str(installed / "hooks/bin/linux-x86_64/decisionctl"),
            "marketplacePath": marketplace_path,
            "rollback": rollback}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload", required=True, type=Path)
    parser.add_argument("--codex", required=True, type=Path)
    parser.add_argument("--data-directory", type=Path)
    args = parser.parse_args()
    try:
        # Serialize different VS Code windows before invoking CLI configuration writes.
        root = safe_path(Path.home() / ".local/state/codex-decision")
        if str(root).startswith("/mnt/d/"):
            raise ValueError("Decision installation state must remain outside D:")
        root.mkdir(parents=True, exist_ok=True, mode=0o700)
        lock = safe_path(root / ".integrated-install.lock")
        descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW, 0o600)
        with os.fdopen(descriptor, "w") as stream:
            fcntl.flock(stream, fcntl.LOCK_EX)
            print(json.dumps(install(args.payload, args.codex, data_directory=args.data_directory)))
    except Exception as error:
        # Do not forward subprocess output or configuration values.
        if isinstance(error, (ValueError, RuntimeError)):
            print(json.dumps({"status": "error", "error": str(error)}))
        else:
            print(json.dumps({"status": "error", "error": "Decision hook installation failed"}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
