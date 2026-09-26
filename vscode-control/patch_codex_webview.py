"""Install or restore the version-pinned local Jev composer control."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import sys


VERSION = "26.917.62051"
ORIGINAL = {
    "out/extension.js": "7ba6208c447c393e050a8ba46893e9e1aa4abd718cb4a8610fa87b12942633bc",
    "webview/index.html": "d91ea97a8bd9e9d67dd048f5496614af4e9eeb33a0dd4b412a6293e06bb3fc02",
}
ASSET = "webview/assets/jev-control.js"
ANCHOR = 'let a=e.onDidReceiveMessage(u=>{if(s.markMessageReceived(),u.type==="chunked-message-ack")'
BRIDGE = (
    'let a=e.onDidReceiveMessage(u=>{'
    'if(u&&u.type==="jev-pilot"){'
    'if(u.action!=="status"&&u.action!=="setSelection")return;'
    'if(u.action==="setSelection"&&typeof u.enabled!=="boolean")return;'
    'Promise.resolve(qe.commands.executeCommand("jevPilot.bridge",'
    '{action:u.action,enabled:u.enabled})).then('
    'v=>e.postMessage({type:"jev-pilot-reply",id:u.id,status:v}),'
    '()=>e.postMessage({type:"jev-pilot-reply",id:u.id,status:'
    '{enabled:false,health:{ok:false,reason:"BRIDGE_UNAVAILABLE"},'
    'busy:false,mode:"observe",recent:"Control unavailable"}}));return}'
    'if(s.markMessageReceived(),u.type==="chunked-message-ack")'
)
SCRIPT = '<script src="./assets/jev-control.js"></script>\n'
MODULE = '<script type="module" crossorigin src="./assets/index-78f8e71b3851.js"></script>'


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def exact_file(root: Path, relative: str) -> Path:
    result = root / relative
    if result.is_symlink() or not result.is_file():
        raise RuntimeError(f"missing or linked file: {relative}")
    return result


def write_exact(path: Path, data: bytes) -> None:
    temporary = path.with_name(path.name + ".jev-temporary")
    if temporary.exists() or temporary.is_symlink():
        raise RuntimeError(f"temporary file exists: {temporary}")
    try:
        temporary.write_bytes(data)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def apply(root: Path, backup: Path) -> None:
    if VERSION not in root.name:
        raise RuntimeError(f"Codex extension {VERSION} is required")
    if root.is_symlink() or backup.is_symlink():
        raise RuntimeError("linked extension or backup directory")
    existing_backup = backup.exists()
    if existing_backup:
        manifest = json.loads(exact_file(backup, "manifest.json").read_text(encoding="utf-8"))
        if manifest.get("version") != VERSION or manifest.get("original") != ORIGINAL:
            raise RuntimeError("rollback metadata changed")
        for relative, expected in ORIGINAL.items():
            if digest(exact_file(backup, relative).read_bytes()) != expected:
                raise RuntimeError(f"rollback file changed: {relative}")
    source_asset = Path(__file__).with_name("webview") / "jev-control.js"
    if not source_asset.is_file():
        raise RuntimeError("missing composer control source")
    if (root / ASSET).exists() or (root / ASSET).is_symlink():
        raise RuntimeError("Codex asset already exists")
    source = {}
    for relative, expected in ORIGINAL.items():
        data = exact_file(root, relative).read_bytes()
        if digest(data) != expected:
            raise RuntimeError(f"Codex extension file changed: {relative}")
        source[relative] = data
    js = source["out/extension.js"].decode("utf-8")
    html = source["webview/index.html"].decode("utf-8")
    if js.count(ANCHOR) != 1 or html.count(MODULE) != 1:
        raise RuntimeError("Codex extension insertion point changed")
    changed = {
        "out/extension.js": js.replace(ANCHOR, BRIDGE).encode("utf-8"),
        "webview/index.html": html.replace(MODULE, SCRIPT + MODULE).encode("utf-8"),
        ASSET: source_asset.read_bytes(),
    }
    if not existing_backup:
        backup.mkdir(parents=True)
        for relative, data in source.items():
            target = backup / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    manifest_data = json.dumps({
        "version": VERSION, "original": ORIGINAL,
        "patched": {key: digest(value) for key, value in changed.items()},
    }, indent=2).encode("utf-8") + b"\n"
    try:
        for relative, data in changed.items():
            target = root / relative
            if relative == ASSET:
                target.write_bytes(data)
            else:
                write_exact(target, data)
        if existing_backup:
            write_exact(backup / "manifest.json", manifest_data)
        else:
            (backup / "manifest.json").write_bytes(manifest_data)
    except Exception:
        for relative, data in source.items():
            write_exact(root / relative, data)
        (root / ASSET).unlink(missing_ok=True)
        raise


def restore(root: Path, backup: Path) -> None:
    if backup.is_symlink():
        raise RuntimeError("linked rollback directory")
    manifest = json.loads(exact_file(backup, "manifest.json").read_text(encoding="utf-8"))
    if manifest.get("version") != VERSION:
        raise RuntimeError("rollback version mismatch")
    for relative, expected in manifest["patched"].items():
        if digest(exact_file(root, relative).read_bytes()) != expected:
            raise RuntimeError(f"patched file changed: {relative}")
    for relative, expected in ORIGINAL.items():
        original = exact_file(backup, relative).read_bytes()
        if digest(original) != expected:
            raise RuntimeError(f"rollback file changed: {relative}")
        write_exact(root / relative, original)
    (root / ASSET).unlink()


def update(root: Path, backup: Path) -> None:
    """Replace only the injected UI asset after verifying the installed patch."""
    if VERSION not in root.name or backup.is_symlink():
        raise RuntimeError("Codex extension version or rollback directory changed")
    manifest_path = exact_file(backup, "manifest.json")
    previous_manifest = manifest_path.read_bytes()
    manifest = json.loads(previous_manifest)
    if manifest.get("version") != VERSION or manifest.get("original") != ORIGINAL:
        raise RuntimeError("rollback metadata changed")
    for relative, expected in manifest["patched"].items():
        if digest(exact_file(root, relative).read_bytes()) != expected:
            raise RuntimeError(f"patched file changed: {relative}")
    for relative, expected in ORIGINAL.items():
        if digest(exact_file(backup, relative).read_bytes()) != expected:
            raise RuntimeError(f"rollback file changed: {relative}")
    source_asset = Path(__file__).with_name("webview") / "jev-control.js"
    new_asset = exact_file(source_asset.parent, source_asset.name).read_bytes()
    target = root / ASSET
    previous_asset = target.read_bytes()
    manifest["patched"][ASSET] = digest(new_asset)
    new_manifest = json.dumps(manifest, indent=2).encode("utf-8") + b"\n"
    try:
        write_exact(target, new_asset)
        write_exact(manifest_path, new_manifest)
    except Exception:
        write_exact(target, previous_asset)
        write_exact(manifest_path, previous_manifest)
        raise


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("apply", "restore", "update"))
    parser.add_argument("--extension", required=True, type=Path)
    parser.add_argument("--backup", required=True, type=Path)
    args = parser.parse_args()
    if args.extension.is_symlink():
        raise RuntimeError("linked extension directory")
    root = args.extension.resolve()
    backup = args.backup.absolute()
    if str(root).lower().startswith("/mnt/d/") or str(backup).lower().startswith("/mnt/d/") or root.drive.lower() == "d:" or backup.drive.lower() == "d:":
        raise RuntimeError("extension and rollback must stay off D:")
    if args.action == "apply":
        apply(root, backup)
    elif args.action == "restore":
        restore(root, backup)
    else:
        update(root, backup)
    print(f"{args.action}: {VERSION} composer control ready")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Jev composer patch: {exc}", file=sys.stderr)
        raise SystemExit(1)
