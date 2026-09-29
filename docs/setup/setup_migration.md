# Migrate an earlier installation

An existing `codex-jev@personal` installation can retain its ID and data directory. Configure `~/.codex/plugins/data/codex-jev-personal/.env` with the [key setup](setup_credentials.md). Point the VS Code control at that directory. This version does not use the former Windows DPAPI cache. Keep the cache for rollback until the new setup works.

For the local 0.4 line migration, install the Rust plugin and paired VS Code control, then run the installed `jevctl migrate-config --data-dir <PLUGIN_DATA>`. It writes schema version 2 with conservative per-line defaults and saves a private `config.v1.<timestamp>.json` rollback copy. It preserves integration selections, mode, model, log policy, and the separate `.env` key. Old whole-output thresholds and method switches do not map to line thresholds. Reload the VS Code window yourself when ready and start a new Codex thread for the new hook definition.

If upgrading from `codex-jev-output-pilot`, run `python3 scripts/migrate_legacy_data.py` from this checkout before selecting an integration. The script copies configuration, metadata, and saved originals. Configure the key in the new plugin data directory. Reload VS Code and start a new Codex thread. Keep old saved outputs while old threads refer to their paths.
