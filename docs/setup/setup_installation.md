# Install and verify

Codex Jev currently packages a Linux x86_64 hook. Install it from this repository's Codex marketplace:

```bash
codex plugin marketplace add https://github.com/PhilippElhaus/Codex-Jev
codex plugin add codex-jev@codex-jev
```

To build the plugin ZIP from source instead, run `./scripts/build_submission.sh`. The archive is written under `.local/submission/`.

Open `/hooks` in the same Codex environment that runs your tools. Review and trust **Codex Jev → PostToolUse**, then start a new thread. Codex does not run a new or changed non-managed hook until it is trusted. The trust record is tied to the hook definition, so a successful API key test alone cannot verify an upgrade.

For every plugin update, run this check before declaring the installation ready:

```bash
python3 scripts/check_hook_trust.py
```

A nonzero exit means the hook is absent, disabled, changed, or untrusted. Open `/hooks`, review the current definition, then rerun the check. Codex manages its trust records; Jev does not rewrite them or silently trust a changed command. The check is the upgrade gate that prevents an old trust record from being mistaken for a working hook.

For the optional Windows VS Code control, build and install its VSIX from WSL:

```bash
cd vscode-control
mkdir -p ../.local/submission
npx @vscode/vsce package --no-dependencies --out ../.local/submission/codex-jev-control-0.7.0.vsix
code --install-extension "$(wslpath -w ../.local/submission/codex-jev-control-0.7.0.vsix)" --force
```

Set `codexJev.dataDirectory` to the installed plugin's absolute `PLUGIN_DATA` directory. Apply the [version-pinned Codex composer patch](../../vscode-control/README.md#install), then reload VS Code. The control needs the same data directory as the hook. It reads the current Codex thread ID from the Codex route. The home screen has no thread yet and stays neutral; a malformed local thread ID shows an error rather than changing shared settings.

A new VS Code Codex session starts with all three filters off. Its switches, mode, cutoffs, decisions, statistics, and health live under `PLUGIN_DATA/sessions/<sha256-of-session-id>/`. The API key remains shared for the local installation in `PLUGIN_DATA/.env`. Selecting a filter creates that session's config. Existing plugin-wide enable flags are not inherited by new sessions.

CLI users without the VS Code control can opt into installation-wide filtering by adding `"scope": "global"` to a schema-2 `PLUGIN_DATA/config.json`, then enabling the desired routes. [config.example.json](../../config.example.json) shows the fields. A session config, when present, overrides this global choice for that session. This global opt-in deliberately affects every session that has no override.

If the control stays amber after a sizeable local text result, check `/hooks`, start a new thread, and confirm that the selected switch matches that tool's route. Red means a configuration, key, API, or hook problem; the original tool result remains visible. [Verification](../development/development_verification.md) gives a repeatable test.
