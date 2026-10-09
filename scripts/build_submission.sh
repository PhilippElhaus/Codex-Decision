#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
    echo 'Submission builds require Linux x86_64 (WSL is supported).' >&2
    exit 2
fi
"$repo_root/scripts/build_hook.sh"
"$repo_root/hooks/bin/linux-x86_64/decisionctl" package --root "$repo_root"
version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$repo_root/.codex-plugin/plugin.json")
python3 "$repo_root/scripts/verify_packages.py" --plugin "$repo_root/.local/submission/codex-decision-$version.zip"
