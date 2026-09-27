"""Install or restore the version-pinned local Jev composer control."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys


VERSION = "26.917.62051"
ORIGINAL = {
    "out/extension.js": "7ba6208c447c393e050a8ba46893e9e1aa4abd718cb4a8610fa87b12942633bc",
    "webview/index.html": "d91ea97a8bd9e9d67dd048f5496614af4e9eeb33a0dd4b412a6293e06bb3fc02",
}
ASSET = "webview/assets/jev-control.js"
SETTINGS_ASSET = "webview/assets/jev-settings.js"
ICON_ASSET = "webview/assets/jev-icon.png"
IMAGE_ASSET = "webview/assets/app-initial-de4359f78ed1.js"
IMAGE_ORIGINAL = "ffdf480c63b5c99009ae0b618cad846ac5f33af42af4cec900f633586370a9dc"
IMAGE_ANCHOR = 'let i=SS(e);if(i==null)return null;try{let e={path:i,hostId:t}'
ANCHOR = 'let a=e.onDidReceiveMessage(u=>{if(s.markMessageReceived(),u.type==="chunked-message-ack")'


def marketplace_path_bridge() -> str:
    """Correct the selected local marketplace path at the Windows-to-WSL edge."""
    personal = Path.home() / ".agents/plugins/marketplace.json"
    marketplace = Path(os.environ.get("CODEX_JEV_MARKETPLACE_PATH") or
                       (personal if personal.is_file() else
                        Path(__file__).resolve().parents[1] / ".agents/plugins/marketplace.json"))
    if not marketplace.is_absolute() or not marketplace.is_file():
        return ""
    try:
        names = [entry["name"] for entry in json.loads(marketplace.read_text())["plugins"]
                 if entry.get("name") in {"codex-jev", "codex-chime"}]
    except (OSError, ValueError, KeyError, TypeError):
        return ""
    if not names:
        return ""
    try:
        converted = subprocess.run(
            ["wslpath", "-w", str(marketplace)], capture_output=True,
            text=True, timeout=3, check=True,
        ).stdout.strip()
    except (OSError, subprocess.SubprocessError):
        return ""
    drive_path = len(converted) >= 3 and converted[0].isalpha() and converted[1:3] == ":\\"
    wsl_path = converted.lower().startswith(("\\\\wsl.localhost\\", "\\\\wsl$\\"))
    if not (drive_path or wsl_path):
        return ""
    aliases = [converted.lower()]
    distro = os.environ.get("WSL_DISTRO_NAME", "")
    if distro and all(char.isalnum() or char in "_-" for char in distro):
        aliases.append(("\\\\wsl.localhost\\" + distro + str(marketplace).replace("/", "\\")).lower())
    aliases_json = json.dumps(aliases, separators=(",", ":"))
    local_json = json.dumps(str(marketplace))
    return (
        'if(u&&u.type==="mcp-request"&&u.request&&u.request.method==="plugin/read"&&'
        'u.request.params&&typeof u.request.params.marketplacePath==="string"){'
        'let p=u.request.params.marketplacePath.toLowerCase().replaceAll("/","\\\\");'
        f'if(({aliases_json}.includes(p)||'
        '(p===".agents\\\\plugins\\\\marketplace.json"||'
        'p===".\\\\.agents\\\\plugins\\\\marketplace.json"))&&'
        f'{json.dumps(names, separators=(",", ":"))}.includes(u.request.params.pluginName))'
        f'u.request.params.marketplacePath={local_json};'
        '}'
    )


def image_path_bridge() -> str:
    """Let Windows VS Code read the two WSL-installed plugin image files."""
    try:
        root = subprocess.run(["wslpath", "-w", "/"], capture_output=True,
                              text=True, timeout=3, check=True).stdout.strip().rstrip("\\")
    except (OSError, subprocess.SubprocessError):
        return ""
    if not root.lower().startswith(("\\\\wsl.localhost\\", "\\\\wsl$\\")):
        return ""
    cache = str(Path.home() / ".codex/plugins/cache/personal")
    return (f'if(i.startsWith({json.dumps(cache + "/codex-jev/")})||'
            f'i.startsWith({json.dumps(cache + "/codex-chime/")}))'
            f'i={json.dumps(root)}+i.replaceAll("/","\\\\");')


def patched_image_asset(original: bytes) -> bytes:
    source = original.decode("utf-8")
    if digest(original) != IMAGE_ORIGINAL or source.count(IMAGE_ANCHOR) != 1:
        raise RuntimeError("Codex image loader changed")
    bridge = image_path_bridge()
    if not bridge:
        raise RuntimeError("WSL image path is unavailable")
    return source.replace(IMAGE_ANCHOR, IMAGE_ANCHOR.replace("try{", bridge + "try{"), 1).encode("utf-8")


BRIDGE = (
    'let a=e.onDidReceiveMessage(u=>{'
    'if(u&&u.type==="codex-jev"){'
    'if(!["status","setSelection","retryConnection","testApiKey","saveApiKey","settingsRead","settingsTest","settingsSave"].includes(u.action))return;'
    'if(u.action==="setSelection"&&typeof u.enabled!=="boolean")return;'
    'if(u.action==="setSelection"&&!(["output","test_build","search_listing"].includes(u.feature)))return;'
    'if(["testApiKey","saveApiKey","settingsTest","settingsSave"].includes(u.action)&&(typeof u.key!=="string"||u.key.length>4096))return;'
    'if(u.action==="settingsSave"&&(!["observe","replace"].includes(u.mode)||!u.thresholds||typeof u.thresholds!=="object"))return;'
    'if(u.viewId!==undefined&&(typeof u.viewId!=="string"||!/^[-\\w:]{1,96}$/.test(u.viewId)))return;'
    'Promise.resolve(qe.commands.executeCommand("codexJev.bridge",'
    '{action:u.action,enabled:u.enabled,feature:u.feature,viewId:u.viewId,key:u.key,mode:u.mode,thresholds:u.thresholds})).then('
    'v=>e.postMessage({type:"codex-jev-reply",id:u.id,status:v}),'
    '()=>e.postMessage({type:"codex-jev-reply",id:u.id,status:'
    '{enabled:false,health:{ok:false,reason:"BRIDGE_UNAVAILABLE"},'
    'busy:false,mode:"replace",recent:"Control unavailable"}}));return}'
) + marketplace_path_bridge() + 'if(s.markMessageReceived(),u.type==="chunked-message-ack")'
SCRIPT = '<script src="./assets/jev-control.js"></script>\n<script src="./assets/jev-settings.js"></script>\n'
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
    settings_asset = Path(__file__).with_name("webview") / "jev-settings.js"
    if not source_asset.is_file() or not settings_asset.is_file():
        raise RuntimeError("missing Jev webview source")
    if any((root / asset).exists() or (root / asset).is_symlink() for asset in (ASSET, SETTINGS_ASSET, ICON_ASSET)):
        raise RuntimeError("Codex asset already exists")
    source = {}
    for relative, expected in ORIGINAL.items():
        data = exact_file(root, relative).read_bytes()
        if digest(data) != expected:
            raise RuntimeError(f"Codex extension file changed: {relative}")
        source[relative] = data
    image_original = exact_file(root, IMAGE_ASSET).read_bytes()
    image_patched = patched_image_asset(image_original)
    js = source["out/extension.js"].decode("utf-8")
    html = source["webview/index.html"].decode("utf-8")
    if js.count(ANCHOR) != 1 or html.count(MODULE) != 1:
        raise RuntimeError("Codex extension insertion point changed")
    changed = {
        "out/extension.js": js.replace(ANCHOR, BRIDGE).encode("utf-8"),
        "webview/index.html": html.replace(MODULE, SCRIPT + MODULE).encode("utf-8"),
        ASSET: source_asset.read_bytes(),
        SETTINGS_ASSET: settings_asset.read_bytes(),
        ICON_ASSET: exact_file(Path(__file__).parent, "icon.png").read_bytes(),
        IMAGE_ASSET: image_patched,
    }
    if not existing_backup:
        backup.mkdir(parents=True)
        for relative, data in source.items():
            target = backup / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        image_backup = backup / IMAGE_ASSET
        image_backup.parent.mkdir(parents=True, exist_ok=True)
        image_backup.write_bytes(image_original)
    elif not (backup / IMAGE_ASSET).is_file():
        raise RuntimeError("missing image rollback file")
    manifest_data = json.dumps({
        "version": VERSION, "original": ORIGINAL,
        "originalImage": IMAGE_ORIGINAL,
        "patched": {key: digest(value) for key, value in changed.items()},
    }, indent=2).encode("utf-8") + b"\n"
    try:
        for relative, data in changed.items():
            target = root / relative
            if relative in (ASSET, SETTINGS_ASSET, ICON_ASSET):
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
        (root / SETTINGS_ASSET).unlink(missing_ok=True)
        (root / ICON_ASSET).unlink(missing_ok=True)
        write_exact(root / IMAGE_ASSET, image_original)
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
    if IMAGE_ASSET in manifest["patched"]:
        original_image = exact_file(backup, IMAGE_ASSET).read_bytes()
        if digest(original_image) != IMAGE_ORIGINAL:
            raise RuntimeError("image rollback file changed")
        write_exact(root / IMAGE_ASSET, original_image)
    (root / ASSET).unlink()
    if SETTINGS_ASSET in manifest["patched"]:
        (root / SETTINGS_ASSET).unlink()
    if ICON_ASSET in manifest["patched"]:
        (root / ICON_ASSET).unlink()


def update(root: Path, backup: Path) -> None:
    """Update the bridge and UI asset after verifying the installed patch."""
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
    settings_asset = Path(__file__).with_name("webview") / "jev-settings.js"
    image_backup = backup / IMAGE_ASSET
    if image_backup.is_file():
        image_original = exact_file(backup, IMAGE_ASSET).read_bytes()
    else:
        image_original = exact_file(root, IMAGE_ASSET).read_bytes()
    image_patched = patched_image_asset(image_original)
    original_js = exact_file(backup, "out/extension.js").read_bytes()
    original_html = exact_file(backup, "webview/index.html").read_bytes()
    js = original_js.decode("utf-8")
    html = original_html.decode("utf-8")
    if js.count(ANCHOR) != 1 or html.count(MODULE) != 1:
        raise RuntimeError("Codex extension insertion point changed")
    changed = {
        "out/extension.js": js.replace(ANCHOR, BRIDGE).encode("utf-8"),
        "webview/index.html": html.replace(MODULE, SCRIPT + MODULE).encode("utf-8"),
        ASSET: exact_file(source_asset.parent, source_asset.name).read_bytes(),
        SETTINGS_ASSET: exact_file(settings_asset.parent, settings_asset.name).read_bytes(),
        ICON_ASSET: exact_file(Path(__file__).parent, "icon.png").read_bytes(),
        IMAGE_ASSET: image_patched,
    }
    for asset in (ICON_ASSET, SETTINGS_ASSET):
        if asset not in manifest["patched"] and ((root / asset).exists() or (root / asset).is_symlink()):
            raise RuntimeError(f"Codex asset already exists: {asset}")
    previous = {relative: exact_file(root, relative).read_bytes() for relative in changed
                if relative in manifest["patched"]}
    for relative, data in changed.items():
        manifest["patched"][relative] = digest(data)
    manifest["originalImage"] = IMAGE_ORIGINAL
    new_manifest = json.dumps(manifest, indent=2).encode("utf-8") + b"\n"
    try:
        if not image_backup.is_file():
            image_backup.parent.mkdir(parents=True, exist_ok=True)
            image_backup.write_bytes(image_original)
        for relative, data in changed.items():
            write_exact(root / relative, data)
        write_exact(manifest_path, new_manifest)
    except Exception:
        for relative, data in previous.items():
            write_exact(root / relative, data)
        for asset in (ICON_ASSET, SETTINGS_ASSET):
            if asset not in previous:
                (root / asset).unlink(missing_ok=True)
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
