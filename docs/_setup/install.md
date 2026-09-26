# Install and configure Codex Jev

## Install

```bash
codex plugin marketplace add https://github.com/PhilippElhaus/Codex-Jev
codex plugin add codex-jev@codex-jev
```

Review and trust the bundled hook when Codex prompts, then start a new thread. All integrations start off. CLI users can enable them with `enabled`, `test_build_enabled`, and `search_listing_enabled` in `PLUGIN_DATA/config.json`. The companion [VS Code control](../../vscode-control/README.md) offers the same three selections.

## Jev API key

Codex Jev reads `JEV_API_KEY` from `PLUGIN_DATA/.env`. This file lives in the installed plugin's user-local data directory, outside the Git repository. The file is plaintext, so keep it private and never commit or share it. The hook checks for owner-only permissions on Linux and fails open to the original tool output if the key is missing or invalid.

From a checkout, use the included prompt to create the file without putting the key in shell history:

```bash
python3 scripts/configure_key.py --data-dir "$HOME/.codex/plugins/data/codex-jev-codex-jev"
```

That path corresponds to `codex-jev@codex-jev` in the default user installation; use your actual `PLUGIN_DATA` path if the marketplace name differs. The file contains one line:

```dotenv
JEV_API_KEY=your-key
```

The parser reads the value as text and never executes the file as shell code. The hook sends a bounded request directly to `https://api.typesafe.ai/v1/systemone` with the key in the HTTPS Authorization header. The key is not placed in command arguments, tool output, Jev decision logs, or the VS Code webview. The companion extension reads the same private file only to probe Jev health when an integration is enabled.

Set `codexJev.dataDirectory` in VS Code to that same absolute `PLUGIN_DATA` directory. On Windows with a WSL installation, use its `\\\\wsl.localhost\\<distro>\\...` path. `CODEX_JEV_DATA_DIRECTORY` is an alternative for the control and is also used by live benchmark scripts.

## Existing personal installation

An existing `codex-jev@personal` installation can retain its ID and data directory. Configure `~/.codex/plugins/data/codex-jev-personal/.env` with the same prompt and point the VS Code control at that directory. The former Windows DPAPI cache is no longer used by this version; keep it for rollback until the new setup works.

If upgrading from the former `codex-jev-output-pilot` ID, first run `python3 scripts/migrate_legacy_data.py` from this checkout to copy configuration, metadata, and saved originals. Then configure the key in the new plugin data directory, reload VS Code, and start a new Codex thread. Keep former saved outputs while old threads still refer to their paths.
