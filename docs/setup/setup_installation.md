# Install Codex Jev

On Linux x86_64, download the plugin ZIP and companion VSIX from the [v0.5.3 release](https://github.com/PhilippElhaus/Codex-Jev/releases/tag/v0.5.3), or build the plugin from source:

```bash
./scripts/build_submission.sh
```

Install from the local marketplace entry that points to the packaged source, then migrate the existing `PLUGIN_DATA/config.json` with the bundled `jevctl migrate-config --data-dir <PLUGIN_DATA>`. The migration saves a version 1 rollback copy. Review and trust the Rust hook when Codex prompts. Start a new Codex thread after installation. Existing integration selections are preserved; new installations start with all three off.

For Windows VS Code, build the companion VSIX from WSL, then install it:

```bash
cd vscode-control
mkdir -p ../.local/submission
npx @vscode/vsce package --no-dependencies --out ../.local/submission/codex-jev-control-0.4.3.vsix
code --install-extension "$(wslpath -w ../.local/submission/codex-jev-control-0.4.3.vsix)" --force
```

Set `codexJev.dataDirectory` to the installed plugin's absolute `PLUGIN_DATA` directory. Enabling an integration opens key setup if no key is saved. The [credential setup](setup_credentials.md) explains that directory and the Jev key. Apply the [version-pinned Codex composer patch](../../vscode-control/README.md#install-the-companion-extension).

When upgrading an existing control, run the patch utility's `update` action as well: the Codex settings page is injected into the Codex extension separately from the Jev VSIX. Reload VS Code yourself after both are installed.


CLI users can select the integrations with `enabled`, `test_build_enabled`, and `search_listing_enabled` in `PLUGIN_DATA/config.json`. See the [config example](../../config.example.json) and [integration behavior](../architecture/design_integrations.md).
