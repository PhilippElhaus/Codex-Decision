# Codex Jev control for VS Code

The companion extension connects the `jev` button in the Codex composer to the installed plugin. It selects three independent integrations: output filter, test/build logs, and search/listing. See [UI behavior](../docs/architecture/design_vscode.md).

## Install the companion extension

Build the VSIX from this checkout, then run:

```bash
npx @vscode/vsce package --no-dependencies
code --install-extension codex-jev-control-0.2.15.vsix --force
```

Set `codexJev.dataDirectory` to the installed plugin's absolute `PLUGIN_DATA` path (on Windows, a `\\wsl.localhost\<distro>\...` path for a WSL installation). `CODEX_JEV_DATA_DIRECTORY` is an alternative. The extension has no machine-specific default. It reads `PLUGIN_DATA/.env` to probe API health. During first setup, the entered key travels through the local Codex webview bridge to the extension; it is not sent as chat text. See [key setup](../docs/setup/setup_credentials.md).

The VSIX includes `patch_codex_webview.py`, `webview/jev-control.js`, and `webview/jev-settings.js`. Run the patch from this checkout or the installed VSIX directory. It supports Codex extension `26.917.62051` and checks exact host hashes. The patch also maps WSL plugin image paths so Windows VS Code can show the Codex Jev and Codex Chime icons. Keep rollback files outside this repository:

```bash
python3 patch_codex_webview.py apply \
  --extension '/mnt/c/Users/<user>/.vscode/extensions/openai.chatgpt-26.917.62051-win32-x64' \
  --backup '/mnt/c/Users/<user>/AppData/Local/Codex/codex-jev/rollback/26.917.62051'
```

Use `update` to refresh an already patched installation, or `restore` with the same paths to roll back. Validate the patch again after a Codex update. Reload each VS Code window after applying or restoring. The bridge can also translate the marketplace path for `plugin/read` when Codex runs in WSL.

## Use it

Select integrations in the composer menu. An empty selection turns Jev off. When an integration is enabled without a key, **Connect Jev** covers the Codex side window with a solid backdrop and asks for a typesafe.ai API key. A link below Save and Skip opens typesafe.ai. Test and save the key there, or choose **Skip for now** to return to Codex; **Connect Jev…** in the Jev menu or **Connect** in the compact missing-key tooltip reopens it. The setup card stacks its buttons when the side window is narrow. Open **Codex settings → Jev**, below **Voice**, to test or replace the key, see lifetime usage, open the decision log in Explorer, change the mode, and adjust each hook's Jev cutoffs with sliders or number fields. Output and test/build filtering require a confident Jev Choice answer in addition to the three safety probabilities. The saved key is never sent back to the webview. **Filter** shortens approved results; **Monitor** records decisions while keeping full output. The stored mode values remain `replace` and `observe` for compatibility. A selection or cutoff change applies when the next tool result completes. A new plugin installation or hook-code change requires a new Codex thread.

![Connect Jev setup overlay in the Codex side window with Skip for now](../docs/images/jev-onboarding.png)

![Compact Jev missing-key tooltip](../docs/images/jev-missing-key.png)

![Illustrative Jev settings with lifetime statistics, Open logs, and confidence cutoffs with sliders](../docs/images/jev-settings.png)

## Verify

```bash
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
python3 scripts/browser_smoke.py
```

The browser smoke test runs the real composer control, key overlay, and settings form against a synthetic VS Code bridge. [Visual harness](tests/visual_harness.html) is the source for the illustrative screenshots. `scripts/capture_docs.py` captures example state without a key.
