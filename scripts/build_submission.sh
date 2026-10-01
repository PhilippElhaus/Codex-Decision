#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
    echo 'Submission builds require Linux x86_64 (WSL is supported).' >&2
    exit 2
fi
target_dir=${CARGO_TARGET_DIR:-"$HOME/.cache/codex-jev/cargo-target"}
export CARGO_TARGET_DIR=$target_dir

release_dir="$target_dir/x86_64-unknown-linux-gnu/release"
cargo build --locked --manifest-path "$repo_root/Cargo.toml" --target x86_64-unknown-linux-gnu --release -p codex-jev
"$release_dir/jevctl" check-release-versions --root "$repo_root"
install -D -m 755 "$release_dir/jev-hook" "$repo_root/hooks/bin/linux-x86_64/jev-hook"
install -D -m 755 "$release_dir/jevctl" "$repo_root/hooks/bin/linux-x86_64/jevctl"
"$release_dir/jevctl" package --root "$repo_root"
version=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$repo_root/.codex-plugin/plugin.json")
python3 "$repo_root/scripts/verify_packages.py" --plugin "$repo_root/.local/submission/codex-jev-$version.zip"
