#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(node -p 'require(process.argv[1]).version' "$repo_root/vscode-control/package.json")
destination="$repo_root/.local/submission/codex-decision-control-$version.vsix"
mkdir -p "$repo_root/.local/submission"
if [ -e "$destination" ]; then
    echo 'Control archive already exists; advance the control version before rebuilding.' >&2
    exit 2
fi
cd "$repo_root/vscode-control"
npx --yes @vscode/vsce@4.0.0 package --no-dependencies --out "$destination"
python3 "$repo_root/scripts/verify_packages.py" --vsix "$destination"
