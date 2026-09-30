# Codex Jev control for VS Code

This optional extension adds Jev switches to the Codex composer, detailed Jev settings, and a bottom-panel view of the latest decision. Set `codexJev.dataDirectory` to the installed plugin's absolute `PLUGIN_DATA` path. Windows VS Code with WSL normally uses a `\\wsl.localhost\<distro>\...` path.

## Install

From this directory in WSL:

```bash
npx @vscode/vsce package --no-dependencies --out ../.local/submission/codex-jev-control-0.7.3.vsix
code --install-extension "$(wslpath -w ../.local/submission/codex-jev-control-0.7.3.vsix)" --force
```

The composer and Codex settings page require the separate local patch for Codex VS Code extension `26.917.62051`. It checks exact host hashes and keeps rollback files outside this repository:

```bash
python3 patch_codex_webview.py update \
  --extension '/mnt/c/Users/<user>/.vscode/extensions/openai.chatgpt-26.917.62051-win32-x64' \
  --backup '/mnt/c/Users/<user>/AppData/Local/Codex/codex-jev/rollback/26.917.62051'
```

Use `apply` for the first installation, `update` after a control upgrade, or `restore` to remove the patch. Reload VS Code after installing both pieces. Start a new Codex thread after a plugin hook upgrade and review the hook in `/hooks` again if its definition changed.

## Use

The three composer switches cover other local output, test/build logs, and search/listing results. Each Codex session has its own switches, Monitor/Filter mode, cutoffs, decisions, counters, and hook status. The pinned patch reads the active session ID from Codex's internal router, even when the webview URL does not change. State lives under `PLUGIN_DATA/sessions/<session-hash>/`; a new local session starts with all three filters selected, and later choices are preserved. On the home screen there is no session yet, so the switches wait until a thread opens. A local thread with an unreadable ID reports an error instead of changing another session's settings. Only the API key in `PLUGIN_DATA/.env` is shared across this installation.

Each open Codex view keeps its own control state. A home view or another thread in the same VS Code window cannot reset the active thread's color, counters, or selection. Older status replies cannot replace newer ones.

Amber means the hook has not been observed recently in this session. Green requires both a successful API check and a recent hook invocation, including a normal skip. Red shows a key, API, configuration, status-file, or hook error. A key test alone never verifies hook trust. If Jev stays amber after eligible tool output, open `/hooks` in Codex, trust the Jev hook, and try a new thread. Short, sensitive, and unsupported results are intentionally skipped.

Open **Codex settings → Jev** to choose Monitor or Filter, adjust line cutoffs, control the Choice gate for long general output, test or replace the key, and open this session's logs. Monitor records decisions but leaves full output visible. Filter can shorten only eligible text after the local evidence checks pass; every shortened result links to its exact original.

The **Jev** panel sits beside Output and Terminal. Reopen it through **View → Open View… → Jev: Latest decision**. It shows up to 250 judged lines from the latest batch in the active session. Blue rows were cut and gold rows were kept. The visual retention index is a display aid; hover for the underlying Jev probabilities. The panel snapshot contains bounded excerpts, not the full output.

## Verify

```bash
npm test
python3 scripts/browser_smoke.py
python3 ../scripts/check_hook_trust.py
```

The browser harnesses use the real composer, settings, and panel code with synthetic, key-free data. The Codex patch must be revalidated against each new Codex extension build.
