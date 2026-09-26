# Migrate an earlier installation

An existing `codex-jev@personal` installation can retain its ID and data directory. Configure `~/.codex/plugins/data/codex-jev-personal/.env` with the [key setup](setup_credentials.md). Point the VS Code control at that directory. This version does not use the former Windows DPAPI cache. Keep the cache for rollback until the new setup works.

If upgrading from `codex-jev-output-pilot`, run `python3 scripts/migrate_legacy_data.py` from this checkout before selecting an integration. The script copies configuration, metadata, and saved originals. Configure the key in the new plugin data directory. Reload VS Code and start a new Codex thread. Keep old saved outputs while old threads refer to their paths.
