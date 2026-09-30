# Install Codex Jev

On Linux x86_64, download the plugin ZIP and companion VSIX from the [v0.6.1 release](https://github.com/PhilippElhaus/Codex-Jev/releases/tag/v0.6.1), or build the plugin from source:

```bash
./scripts/build_submission.sh
```

Install from the local marketplace entry that points to the packaged source, then migrate an older `PLUGIN_DATA/config.json` with the bundled `jevctl migrate-config --data-dir <PLUGIN_DATA>`. The migration saves a version 1 rollback copy. Open `/hooks` in Codex and review and trust the Jev PostToolUse hook. Codex skips new or changed hooks until trusted, even when the plugin is enabled and the API key works. Start a new Codex thread after installation or upgrade. Existing integration selections are preserved; new installations start with all three off.

For source installs, run `python3 scripts/check_hook_trust.py` after each plugin update. The check reads Codex's hook status without changing trust records or contacting Jev. If it reports `modified`, `untrusted`, or `disabled`, open `/hooks` in the same Codex environment, review and trust or enable Jev, then rerun the check. Treat a failed check as an incomplete upgrade. Codex owns the old trust record and replaces it when you trust the current definition.

For Windows VS Code, build the companion VSIX from WSL, then install it:

```bash
cd vscode-control
mkdir -p ../.local/submission
npx @vscode/vsce package --no-dependencies --out ../.local/submission/codex-jev-control-0.5.1.vsix
code --install-extension "$(wslpath -w ../.local/submission/codex-jev-control-0.5.1.vsix)" --force
```

Set `codexJev.dataDirectory` to the installed plugin's absolute `PLUGIN_DATA` directory. Enabling an integration opens key setup if no key is saved. The [credential setup](setup_credentials.md) explains that directory and the Jev key. Apply the [version-pinned Codex composer patch](../../vscode-control/README.md#install).

When upgrading an existing control, run the patch utility's `update` action as well: the Codex settings page is injected into the Codex extension separately from the Jev VSIX. Reload VS Code yourself after both are installed.


CLI users can select the integrations with `enabled`, `test_build_enabled`, and `search_listing_enabled` in `PLUGIN_DATA/config.json`. See the [config example](../../config.example.json) and [integration behavior](../architecture/design_integrations.md).

If Jev shows zero checked results after a session, first inspect `/hooks` in the same Codex environment that runs the tools. Trust a pending Jev hook, then start a new thread and run an eligible local command with at least 256 characters of plain-text output. The three switches cover separate routes; turn on the switch for that command. The green VS Code connection indicator checks only the Jev API and key. Small, sensitive, structured, and unsupported results make no Jev request.
