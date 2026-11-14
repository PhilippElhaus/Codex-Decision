"""Shared source snapshots and conservative function-coverage selection."""
from difflib import SequenceMatcher
from hashlib import sha256
from pathlib import Path
import json
import os
import platform
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
STATE = ROOT / ".cache/tia"
VERSION = 3


def command(args, **kwargs):
    return subprocess.run([str(arg) for arg in args], cwd=ROOT, check=True,
                          text=True, **kwargs)


def inventory():
    result = command(["git", "ls-files", "-z", "--cached", "--others",
                      "--exclude-standard"], capture_output=True)
    files = {}
    for name in sorted(set(result.stdout.split("\0")) - {""}):
        path = ROOT / name
        if not path.exists():
            continue
        if path.is_symlink() or not path.is_file():
            raise ValueError(f"Unsupported source entry: {name}")
        data = path.read_bytes()
        files[name] = {"hash": sha256(data).hexdigest()}
        if path.suffix in {".rs", ".js", ".cjs", ".py"}:
            files[name]["text"] = data.decode("utf-8")
    return files


def environment(family):
    args = {"node": ["node", "--version"], "rust": ["rustc", "-vV"],
            "python": [sys.executable, "--version"]}
    versions = {key: command(value, capture_output=True).stdout.strip() for key, value in args.items()}
    cli = os.environ.get("DECISIONCTL_TEST", "")
    cli_hash = sha256(Path(cli).read_bytes()).hexdigest() if cli and Path(cli).is_file() else None
    mask = None
    if os.name != "nt":
        mask = os.umask(0)
        os.umask(mask)
    return {"platform": platform.platform(), "machine": platform.machine(),
            "runtime": versions, "family": family, "umask": mask,
            "cli": cli, "cli_hash": cli_hash,
            "wsl": os.environ.get("CODEX_DECISION_TEST_WSL_DISTRO", ""),
            "rustflags": os.environ.get("RUSTFLAGS", ""),
            "target": os.environ.get("CARGO_TARGET_DIR", ""),
            "node_options": os.environ.get("NODE_OPTIONS", ""),
            "encoded_rustflags": os.environ.get("CARGO_ENCODED_RUSTFLAGS", ""),
            "rust_target": os.environ.get("CARGO_BUILD_TARGET", ""),
            "python_path": os.environ.get("PYTHONPATH", "")}


def temporary_directory(prefix):
    parent = Path("/tmp") if sys.platform.startswith("linux") else Path(tempfile.gettempdir())
    resolved = parent.resolve()
    if resolved.drive.lower() == "d:" or str(resolved).lower() == "/mnt/d" or str(resolved).lower().startswith("/mnt/d/"):
        raise ValueError("TIA temporary data must stay outside D:")
    return tempfile.TemporaryDirectory(prefix=prefix, dir=resolved)


def baseline_path(family):
    return STATE / f"{family}.json"


def prepare_native_cli():
    if not os.environ.get("DECISIONCTL_TEST"):
        target = Path(os.environ.get("CARGO_TARGET_DIR", ROOT / ".cache/cargo"))
        cli = target / "debug" / ("decisionctl.exe" if os.name == "nt" else "decisionctl")
        if cli.is_file():
            os.environ["DECISIONCTL_TEST"] = str(cli.resolve())


def save(family, files, tests, functions):
    if not tests:
        raise ValueError("No tests recorded; refusing an empty baseline")
    value = {"version": VERSION, "environment": environment(family),
             "files": files, "tests": tests, "functions": functions}
    value["manifest_hash"] = sha256(json.dumps(value, sort_keys=True).encode()).hexdigest()
    STATE.mkdir(parents=True, exist_ok=True)
    destination = baseline_path(family)
    pending = destination.with_suffix(".pending")
    pending.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
    pending.replace(destination)


def relevant(family, name):
    if name.startswith("docs/") or name.endswith(".md"):
        return family == "python"
    return True


def source_family(family, name):
    if family == "rust":
        return name.startswith("rust/decision/") and name.endswith(".rs")
    if family == "node":
        return (name.startswith(("vscode-control/", "scripts/", "tests/"))
                and name.endswith((".js", ".cjs"))
                and not name.startswith(("vscode-control/webview/", "tests/fixtures/")))
    return name.startswith(("scripts/", "vscode-control/", "tests/")) and name.endswith(".py")


def select(family, baseline, current):
    """Return test identities or a full-suite reason. No evidence means full."""
    def full(reason):
        return {"mode": "full", "reason": reason, "tests": []}
    if not baseline or baseline.get("version") != VERSION:
        return full("missing or incompatible function coverage")
    if baseline.get("environment") != environment(family):
        return full("runtime, platform, or native CLI changed")
    old = baseline["files"]
    changed = [p for p in old.keys() | current.keys()
               if relevant(family, p) and old.get(p) != current.get(p)]
    if not changed:
        return {"mode": "selected", "reason": "source snapshot is unchanged", "tests": []}
    affected = set()
    for name in changed:
        if name not in old or name not in current:
            return full(f"added or deleted input: {name}")
        if not source_family(family, name):
            return full(f"shared, dynamic, configuration, or cross-language input: {name}")
        before, after = old[name].get("text"), current[name].get("text")
        if before is None or after is None:
            return full(f"source unavailable: {name}")
        spans = baseline["functions"].get(name, [])
        mapped = False
        for tag, i, j, _a, _b in SequenceMatcher(None, before.splitlines(), after.splitlines(),
                                               autojunk=False).get_opcodes():
            if tag == "equal":
                continue
            mapped = True
            # Include both neighbours of an insertion. A new module-level
            # declaration cannot inherit the preceding function's coverage.
            first, last = (max(1, i), i + 1) if i == j else (i + 1, j)
            owners = [s for s in spans if s[0] <= first and s[1] >= last]
            if not owners:
                return full(f"module-level or unmapped change: {name}:{first}")
            owner = min(owners, key=lambda s: s[1] - s[0])
            hits = [t["id"] for t in baseline["tests"]
                    if owner in t["spans"].get(name, []) or name in t.get("reads", [])
                    or "*process*" in t.get("reads", [])]
            if not hits:
                return full(f"changed function has no test evidence: {name}:{first}")
            affected.update(hits)
        if not mapped:
            return full(f"source bytes changed outside line mapping: {name}")
    # Native process boundaries can clear inherited instrumentation settings.
    # Keep the complete Cargo integration targets alongside selected unit cases.
    if family == "rust":
        affected.update(t["id"] for t in baseline["tests"] if t.get("kind") == "test")
    return {"mode": "selected", "reason": "changed functions intersect per-test coverage",
            "tests": [t for t in baseline["tests"] if t["id"] in affected]}


def load(family):
    try:
        value = json.loads(baseline_path(family).read_text(encoding="utf-8"))
        expected = value.pop("manifest_hash", None)
        if expected != sha256(json.dumps(value, sort_keys=True).encode()).hexdigest():
            return None
        if not isinstance(value.get("files"), dict) or not value.get("tests"):
            return None
        return value
    except (OSError, ValueError, TypeError, AttributeError):
        return None
