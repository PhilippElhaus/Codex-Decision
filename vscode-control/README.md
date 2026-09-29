# Codex Jev control for VS Code

This optional extension adds the **Jev** bottom panel, three integration toggles in the Codex composer, and line-level settings. It reads the installed plugin's `PLUGIN_DATA`; set `codexJev.dataDirectory` to that absolute directory in VS Code settings. On Windows with WSL, use its `\\wsl.localhost\<distro>\...` path.

## Install

From this directory in WSL:

```bash
npx @vscode/vsce package --no-dependencies --out ../.local/submission/codex-jev-control-0.4.1.vsix
code --install-extension "$(wslpath -w ../.local/submission/codex-jev-control-0.4.1.vsix)" --force
```

The composer control requires a separately installed, version-pinned local patch for Codex extension `26.917.62051`. The patch verifies exact host hashes and keeps rollback files outside this repository:

```bash
python3 patch_codex_webview.py update \
  --extension '/mnt/c/Users/<user>/.vscode/extensions/openai.chatgpt-26.917.62051-win32-x64' \
  --backup '/mnt/c/Users/<user>/AppData/Local/Codex/codex-jev/rollback/26.917.62051'
```

Use `apply` for the first installation, `update` after each Jev control upgrade, or `restore` to roll back. The settings script runs inside the patched Codex webview, so installing the VSIX alone does not update that page. The patch utility is still Python; the packaged Jev hook runs as Rust without Python. Reload the VS Code window yourself after both updates. A new Codex thread picks up a newly installed plugin hook.

## Use

The **Jev** tab appears beside Output and Terminal. Hide it from its tab menu and reopen it with **View → Open View… → Jev: Latest decision**. VS Code does not expose a contribution point for a direct custom entry in its top-level View menu. The panel stays empty until a version 2 line decision arrives. It shows five recent judged source lines, the latest actual excerpt, result totals, two independent Noul probabilities, and a third task-relevance probability for search. Rows stay fixed in place as new lines arrive; full-block `█` bars fill over 800 ms and percentages fade in. The panel snapshot contains only bounded excerpts, not the full output.

In **Codex settings → Jev**, choose Monitor or Filter and set the `Can omit` minimum and `Exact text needed` maximum for each route. Search relevance is always rated and shown; its optional keep guard starts disabled. Monitor records line judgments while returning the full output. Filter may shorten an output only when every omitted line passes its own thresholds and local evidence protections. Changes apply to the next tool result. A private receipt stores the original once; batch records store requests and answers. **Open logs** opens the private log directory. Saved originals live separately under `PLUGIN_DATA/outputs/`.

## Verify

```bash
npm test
python3 scripts/browser_smoke.py
```

The panel's synthetic [browser harness](../tests/browser/jev_panel_harness.html) renders the real webview code in dark and light colors. The [documentation captures](../docs/images/) use the current webview code and synthetic, key-free state.
