#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
target_dir=${CARGO_TARGET_DIR:-"$HOME/.cache/codex-jev/cargo-target"}
export CARGO_TARGET_DIR=$target_dir

cargo build --manifest-path "$repo_root/Cargo.toml" --release -p codex-jev
"$target_dir/release/jevctl" check-release-versions --root "$repo_root"
install -D -m 755 "$target_dir/release/jev-hook" "$repo_root/hooks/bin/linux-x86_64/jev-hook"
install -D -m 755 "$target_dir/release/jevctl" "$repo_root/hooks/bin/linux-x86_64/jevctl"
"$target_dir/release/jevctl" package --root "$repo_root"
