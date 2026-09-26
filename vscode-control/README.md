# Codex Jev control for VS Code

The companion extension connects the `jev` button in the Codex composer to the installed plugin. It selects three independent integrations: output filter, test/build logs, and search/listing. See [UI behavior](../docs/architecture/design_vscode.md).

## Install the companion extension

Download the current VSIX from the [GitHub release](https://github.com/PhilippElhaus/Codex-Jev/releases/latest), then run:

```bash
code --install-extension codex-jev-control-0.2.5.vsix --force
```

To build it from a checkout, run from `vscode-control/`:

```bash
npx @vscode/vsce package --no-dependencies
code --install-extension <generated-vsix> --force
```

Set `codexJev.dataDirectory` to the installed plugin's absolute `PLUGIN_DATA` path (on Windows, a `\\wsl.localhost\<distro>\...` path for a WSL installation). `CODEX_JEV_DATA_DIRECTORY` is an alternative. The extension has no machine-specific default. It reads `PLUGIN_DATA/.env` to probe API health; the key never enters the webview. See [key setup](../docs/setup/setup_credentials.md).

The VSIX includes `patch_codex_webview.py` and `webview/jev-control.js`. Run the patch from this checkout or the installed VSIX directory. It supports Codex extension `26.917.62051` and checks exact host hashes. Keep rollback files outside this repository:

```bash
python3 patch_codex_webview.py apply \
  --extension '/mnt/c/Users/<user>/.vscode/extensions/openai.chatgpt-26.917.62051-win32-x64' \
  --backup '/mnt/c/Users/<user>/AppData/Local/Codex/codex-jev/rollback/26.917.62051'
```

Use `update` to refresh an already patched installation, or `restore` with the same paths to roll back. Validate the patch again after a Codex update. Reload each VS Code window after applying or restoring. The bridge can also translate the marketplace path for `plugin/read` when Codex runs in WSL.

## Use it

Select integrations in the composer menu. An empty selection turns Jev off. The default mode is `replace`; choose `observe` in **Codex Jev Control: Mode** to record decisions while keeping full tool output. A selection change applies when the next tool result completes. A new plugin installation or hook-code change requires a new Codex thread.

## Verify

```bash
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/browser_smoke.py
```

The browser smoke test runs the real composer control against a synthetic VS Code bridge. [Visual harness](tests/visual_harness.html) is the source for the README screenshots.
