"""Install the VSIX's hook payload through Codex without changing private state."""

import argparse
from contextlib import contextmanager
import errno
import fcntl
import importlib.util
import json
import os
from pathlib import Path
import re
import selectors
import subprocess
import stat
import tempfile
import time


PLUGIN = "codex-decision"
FILES = (
    ".codex-plugin/plugin.json", "skills/decision-output/SKILL.md", "hooks/hooks.json",
    "hooks/bin/linux-x86_64/decision-hook", "hooks/bin/linux-x86_64/decisionctl",
    "hooks/bin/windows-x86_64/decision-hook.exe", "hooks/bin/windows-x86_64/decisionctl.exe",
    "assets/logo.png", "assets/icon.png", "config.example.json", "LICENSE",
)
_CACHE_SPEC = importlib.util.spec_from_file_location("decision_install_cache", Path(__file__).with_name("install_cache.py"))
cache = importlib.util.module_from_spec(_CACHE_SPEC)
_CACHE_SPEC.loader.exec_module(cache)


def safe_path(path):
    path = Path(os.path.abspath(path))
    for item in (*reversed(path.parents), path):
        if item.is_symlink():
            raise ValueError("Decision installation paths must not contain symbolic links")
    return path


def read_json(path):
    return json.loads(package_bytes(path, 128_000))


def package_bytes(path, limit=cache.MAX_FILE_BYTES):
    path = safe_path(path)
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > limit:
        raise ValueError("Decision package file is invalid or exceeds its size limit")
    return cache.read_file(path, info, safe_path)


def package_matches(root, incoming):
    for filename, data in incoming.items():
        target = safe_path(root / filename)
        if (not target.is_file() or target.stat().st_size != len(data) or package_bytes(target) != data or
                filename.startswith("hooks/bin/") and not target.stat().st_mode & 0o111):
            return False
    return True


def version_tuple(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d+\.\d+\.\d+(?:\+[A-Za-z0-9.-]+)?", value):
        raise ValueError("Invalid Decision package version")
    return tuple(map(int, value.split("+", 1)[0].split(".")))


def run_codex(binary, args, timeout=90):
    command = [str(binary), "plugin", *args, "--json"]
    deadline = time.monotonic() + timeout
    # CLI stderr can contain unrelated configuration. Do not retain it.
    with subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL) as process:
        output = bytearray()
        try:
            with selectors.DefaultSelector() as selector:
                selector.register(process.stdout, selectors.EVENT_READ)
                while True:
                    remaining = deadline - time.monotonic()
                    if remaining <= 0 or not selector.select(remaining):
                        raise subprocess.TimeoutExpired(command, timeout)
                    chunk = os.read(process.stdout.fileno(), min(65536, 2_000_001 - len(output)))
                    if not chunk:
                        break
                    output.extend(chunk)
                    if len(output) > 2_000_000:
                        raise RuntimeError("Codex plugin metadata exceeds the installation limit")
            if process.wait(timeout=max(0, deadline - time.monotonic())):
                raise RuntimeError("Codex plugin command failed: " + " ".join(args[:2]))
        except BaseException:
            if process.poll() is None:
                process.kill()
            process.wait()
            raise
    return json.loads(output.decode("utf-8"))


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


def source_changes(payload, source, incoming_bytes=None):
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
        data = incoming_bytes[filename] if incoming_bytes is not None else package_bytes(incoming)
        if target.exists() and target.stat().st_size > cache.MAX_FILE_BYTES:
            raise ValueError("Decision package file is invalid or exceeds its size limit")
        if not target.exists() or target.stat().st_size != len(data) or package_bytes(target) != data or (
                filename.startswith("hooks/bin/") and not target.stat().st_mode & 0o111):
            changed.append(filename)
    return changed


def update_source(payload, source, backup_root, changed=None, rollback=None, incoming=None):
    changed = source_changes(payload, source) if changed is None else changed
    if not changed:
        return False, rollback
    rollback = Path(rollback) if rollback else None
    for filename in changed:
        target = source / filename
        if target.exists():
            if rollback is None:
                backup_root = safe_path(backup_root)
                backup_root.mkdir(parents=True, exist_ok=True, mode=0o700)
                rollback = Path(tempfile.mkdtemp(prefix=f"{int(time.time())}-", dir=backup_root))
                write_exact(rollback / "source.json", json.dumps({"source": str(source)}).encode())
            write_exact(rollback / filename, package_bytes(target), filename.startswith("hooks/bin/"))
        write_exact(target, incoming[filename] if incoming is not None else package_bytes(payload / filename), filename.startswith("hooks/bin/"))
    return True, str(rollback) if rollback else None


def install(payload, codex, home=None, codex_home=None, run=run_codex, data_directory=None,
            report_phase=lambda _phase: None):
    report_phase("package inspection")
    home = safe_path(home or Path.home())
    codex_home = safe_path(codex_home or os.environ.get("CODEX_HOME", home / ".codex"))
    payload = safe_path(payload)
    for root in [home, codex_home]:
        if str(root) == "/mnt/d" or str(root).startswith("/mnt/d/"):
            raise ValueError("Decision installation state must remain outside D:")
    incoming = {filename: package_bytes(payload / filename, 128_000 if filename == ".codex-plugin/plugin.json" else cache.MAX_FILE_BYTES)
                for filename in FILES}
    manifest = read_json(payload / ".codex-plugin/plugin.json")
    if manifest.get("name") != PLUGIN:
        raise ValueError("Invalid Decision hook payload")
    version = manifest.get("version")
    expected_version = version_tuple(version)
    report_phase("Codex plugin discovery")
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
    report_phase("package update")
    planned = source_changes(payload, source, incoming)
    cache_root = safe_path(codex_home / "plugins/cache" / marketplace / PLUGIN)
    installed = safe_path(cache_root / version)
    cache_matches = package_matches(installed, incoming)
    refreshed = registration_needed or bool(planned) or not cache_matches or current.get("version") != version
    result = {"pluginId": plugin_id, "version": version, "pluginRoot": str(installed),
              "dataDirectory": str(expected_data_directory),
              "decisionctl": str(installed / "hooks/bin/linux-x86_64/decisionctl"), "marketplacePath": marketplace_path}
    if not refreshed:
        report_phase("installed package verification")
        return {**result, "status": "ready", "rollback": None}
    snapshots = cache.snapshot(cache_root, safe_path, version_tuple, PLUGIN)
    rollback = cache.save(snapshots, backup_root, cache_root, source, safe_path, write_exact)
    verified = False
    try:
        _, rollback = update_source(payload, source, backup_root, planned, rollback, incoming)
        if registration_needed:
            write_exact(path, (json.dumps(metadata, indent=2) + "\n").encode())
            run(codex, ["marketplace", "add", str(marketplace_root)])
        if refreshed:
            report_phase("Codex plugin registration")
            run(codex, ["add", plugin_id])
        report_phase("installed package verification")
        selected = existing_plugin(run(codex, ["list"]))
        if not selected or selected.get("pluginId") != plugin_id or selected.get("version") != version or selected.get("enabled") is not True:
            raise RuntimeError("Codex did not activate the packaged Decision version")
        if not package_matches(installed, incoming):
            raise RuntimeError("Codex cached Decision package differs from the VSIX")
        verified = True
    finally:
        cache.restore(cache_root, snapshots, version if verified else None, safe_path, FILES)
    return {**result, "status": "installed", "rollback": rollback}


def installation_failure(error, phase):
    """Expose a fixed diagnostic, never OS paths, CLI output, or private state."""
    retryable = False
    if isinstance(error, json.JSONDecodeError):
        detail = "invalid JSON metadata"
    elif isinstance(error, subprocess.TimeoutExpired):
        detail = "Codex command timed out"
        retryable = True
    elif isinstance(error, OSError):
        temporary = {errno.EAGAIN, errno.EBUSY, errno.EINTR, errno.EIO, errno.ESTALE, errno.ETIMEDOUT}
        retryable = error.errno in temporary
        detail = ("temporary file or process access failure" if retryable else
                  "file or executable missing" if error.errno == errno.ENOENT else
                  "file access denied" if error.errno in {errno.EACCES, errno.EPERM} else
                  "operating system access failure")
    elif isinstance(error, (ValueError, RuntimeError)):
        return {"status": "error", "error": str(error), "retryable": False}
    else:
        detail = "unexpected installation error"
    return {"status": "error", "error": f"Decision hook installation failed during {phase}: {detail}",
            "retryable": retryable}


@contextmanager
def installation_lock(codex_home, timeout=660):
    # Both companions mutate the same Codex registration. Keep one kernel lock
    # per runtime, and retain its inode so waiting processes cannot bypass it.
    root = safe_path(Path(codex_home) / "plugins")
    if str(root) == "/mnt/d" or str(root).startswith("/mnt/d/"):
        raise ValueError("Decision installation state must remain outside D:")
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor = os.open(safe_path(root / ".companion-install.lock"),
                         os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "r+b") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError("Decision installation lock must be a regular file")
        deadline = time.monotonic() + timeout
        while True:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as error:
                if error.errno == errno.EINTR:
                    if time.monotonic() >= deadline:
                        raise BlockingIOError(errno.EAGAIN, "installation lock was repeatedly interrupted") from None
                    continue
                if error.errno not in {errno.EACCES, errno.EAGAIN}:
                    raise
                if time.monotonic() >= deadline:
                    raise BlockingIOError(errno.EAGAIN, "installation is busy") from None
                time.sleep(0.1)
        try:
            yield
        finally:
            fcntl.flock(stream, fcntl.LOCK_UN)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--payload", required=True, type=Path)
    parser.add_argument("--codex", required=True, type=Path)
    parser.add_argument("--data-directory", type=Path)
    args = parser.parse_args()
    phase = "installation lock"
    try:
        codex_home = safe_path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
        with installation_lock(codex_home):
            def report_phase(value):
                nonlocal phase
                phase = value
            print(json.dumps(install(args.payload, args.codex, data_directory=args.data_directory,
                                     report_phase=report_phase)))
    except Exception as error:
        print(json.dumps(installation_failure(error, phase)))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
