# Install Codex Jev

The line-level release is local in this checkout. Build and package it on Linux x86_64:

```bash
./scripts/build_submission.sh
```

Install from the local marketplace entry that points to the packaged source, then migrate the existing `PLUGIN_DATA/config.json` with the bundled `jevctl migrate-config --data-dir <PLUGIN_DATA>`. The migration saves a version 1 rollback copy. Review and trust the Rust hook when Codex prompts. Start a new Codex thread after installation. Existing integration selections are preserved; new installations start with all three off.

For Windows VS Code, build the companion VSIX from WSL, then install it:

```bash
cd vscode-control
mkdir -p ../.local/submission
npx @vscode/vsce package --no-dependencies --out ../.local/submission/codex-jev-control-0.3.0.vsix
code --install-extension "$(wslpath -w ../.local/submission/codex-jev-control-0.3.0.vsix)" --force
```

Set `codexJev.dataDirectory` to the installed plugin's absolute `PLUGIN_DATA` directory. Enabling an integration opens key setup if no key is saved. The [credential setup](setup_credentials.md) explains that directory and the Jev key. Apply the [version-pinned Codex composer patch](../../vscode-control/README.md#install-the-companion-extension).


CLI users can select the integrations with `enabled`, `test_build_enabled`, and `search_listing_enabled` in `PLUGIN_DATA/config.json`. See the [config example](../../config.example.json) and [integration behavior](../architecture/design_integrations.md).
