# Install Codex Jev

Run these commands in the terminal used by Codex:

```bash
codex plugin marketplace add https://github.com/PhilippElhaus/Codex-Jev
codex plugin add codex-jev@codex-jev
```

Review and trust the bundled hook when Codex prompts. Start a new Codex thread after installation. All three integrations start off.

For VS Code, download `codex-jev-control-0.2.1.vsix` from the [latest release](https://github.com/PhilippElhaus/Codex-Jev/releases/latest), then install it:

```bash
code --install-extension codex-jev-control-0.2.1.vsix --force
```

The extension provides a status-bar selector. Set `codexJev.dataDirectory` to the installed plugin's absolute `PLUGIN_DATA` directory. The [credential setup](setup_credentials.md) explains that directory and the Jev key. The optional in-composer button uses a [version-pinned Codex patch](../../vscode-control/README.md#install-the-companion-extension).

CLI users can select the integrations with `enabled`, `test_build_enabled`, and `search_listing_enabled` in `PLUGIN_DATA/config.json`. See the [config example](../../config.example.json) and [integration behavior](../architecture/design_integrations.md).
