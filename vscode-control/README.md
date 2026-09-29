# Codex Jev control for VS Code

This optional extension adds the **Jev** bottom panel, three integration toggles in the Codex composer, and line-level settings. It reads the installed plugin's `PLUGIN_DATA`; set `codexJev.dataDirectory` to that absolute directory in VS Code settings. On Windows with WSL, use its `\\wsl.localhost\<distro>\...` path.

## Install

From this directory in WSL:

```bash
npx @vscode/vsce package --no-dependencies --out ../.local/submission/codex-jev-control-0.5.1.vsix
code --install-extension "$(wslpath -w ../.local/submission/codex-jev-control-0.5.1.vsix)" --force
```

The composer control requires a separately installed, version-pinned local patch for Codex extension `26.917.62051`. The patch verifies exact host hashes and keeps rollback files outside this repository:

```bash
python3 patch_codex_webview.py update \
  --extension '/mnt/c/Users/<user>/.vscode/extensions/openai.chatgpt-26.917.62051-win32-x64' \
  --backup '/mnt/c/Users/<user>/AppData/Local/Codex/codex-jev/rollback/26.917.62051'
```

Use `apply` for the first installation, `update` after each Jev control upgrade, or `restore` to roll back. The settings script runs inside the patched Codex webview, so installing the VSIX alone does not update that page. The patch utility is still Python; the packaged Jev hook runs as Rust without Python. Reload the VS Code window yourself after both updates. A new Codex thread picks up a newly installed plugin hook.

## Use

The **Jev** tab appears beside Output and Terminal. Hide it from its tab menu and reopen it with **View → Open View… → Jev: Latest decision**. VS Code does not expose a contribution point for a direct custom entry in its top-level View menu. The panel stays empty until a version 3 batch decision arrives. It shows up to 250 judged source lines from the latest batch, each with a bounded excerpt, Keep/Omit result, and a 0–1 visual **retention index**. Blue cut rows sit near zero; gold kept rows sit near one. The index is derived locally from the final action and the Noul probabilities; it is not itself a Jev probability. Hover a row for the underlying omission, exact-text, and task-relevance scores and its keep reason. Dense batches flow into columns and the header shows the total kept versus source lines. Full-block `█` bars grow together over 900 ms even when Windows reports reduced motion, values fade in, and the batch rests for another second. Rapid updates coalesce to the newest batch. Long batches use the panel's page scroll without a nested scrollbar. The snapshot contains only bounded excerpts, not the full output.

In **Codex settings → Jev**, choose Monitor or Filter and set the `Can omit` minimum and `Exact text needed` maximum for each route. Search relevance is always rated and shown; its optional keep guard starts disabled. Monitor records line judgments while returning the full output. Filter may shorten an output only when every omitted line passes its own thresholds and local evidence protections. Changes apply to the next tool result. A private receipt stores the original once; batch records store requests and answers. **Open logs** opens the private log directory. Saved originals live separately under `PLUGIN_DATA/outputs/`.

The composer switches control separate input routes. Recognized test/build and search/listing commands or tools use only their own switch. If that switch is off, the result is untouched and does not appear as a new decision or statistic, even if Output filter is on. Output filter handles other eligible local plain text. A 256-byte minimum avoids calls for tiny replies; structured and mutating tool results remain untouched.

## Verify

```bash
npm test
python3 scripts/browser_smoke.py
```

The panel's synthetic [browser harness](../tests/browser/jev_panel_harness.html) renders the real webview code in dark and light colors. The [documentation captures](../docs/images/) use the current webview code and synthetic, key-free state.
