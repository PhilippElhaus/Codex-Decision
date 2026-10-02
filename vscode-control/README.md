# Codex Jev control for VS Code

This optional extension adds Jev switches to the Codex composer, detailed Jev settings, and a bottom-panel view of the latest decision. Set `codexJev.dataDirectory` to the installed plugin's absolute `PLUGIN_DATA` path. Windows VS Code with WSL normally uses a `\\wsl.localhost\<distro>\...` path.

## Install

From this directory in WSL:

```bash
../scripts/build_control.sh
code --install-extension "$(wslpath -w ../.local/submission/codex-jev-control-0.7.8.vsix)" --force
```

The composer and Codex settings page require the separate local patch for Codex VS Code extensions `26.928.31416` and `26.930.21537`. It checks exact host hashes and keeps rollback files outside this repository:

```bash
../hooks/bin/linux-x86_64/jevctl patch-webview update --root .. \
  --extension '/mnt/c/Users/<user>/.vscode/extensions/openai.chatgpt-26.930.21537-win32-x64' \
  --backup '/mnt/c/Users/<user>/AppData/Local/Codex/codex-jev/rollback/26.930.21537'
```

Use `apply` for the first installation, `update` after a control upgrade, or `restore` to remove the patch. Reload VS Code after installing both pieces. Start a new Codex thread after a plugin hook upgrade and review the hook in `/hooks` again if its definition changed.

## Use

The three composer switches cover other local output, test/build logs, and search/listing results. Each Codex session has its own switches, decisions, counters, and hook status. The pinned patch reads the active session ID from Codex's internal router, even when the webview URL does not change. State lives under `PLUGIN_DATA/sessions/<session-hash>/`; a new local session starts with all three filters selected, and later choices are preserved. On the home screen, the switches wait until a thread opens and the menu explains this requirement. A local thread with an unreadable ID cannot change another session's switches. The API key in `PLUGIN_DATA/.env` and behavior settings in `PLUGIN_DATA/settings.json` are shared across this installation.

Each open Codex view keeps its own control state. A home view or another thread in the same VS Code window cannot reset the active thread's color, counters, or selection. Older status replies cannot replace newer ones. Each selection waits for its host acknowledgement before accepting another click on that switch. If the host does not reply within ten seconds, the menu reports the connection failure and the control offers Retry.

The indicator is green after a small successful Jev API request, red on a missing key or failed request, and amber while that check is pending. It checks the API even on the home screen or when every filter is off. The activity tooltip is hidden on the home screen. Hook and session errors appear in the tooltip during a thread. An API check does not verify hook trust; review `/hooks` after installing or updating the hook. After a minute without a hook receipt, the tooltip explains how to check the hook. Windows WSL paths receive private Linux permissions, including existing session folders created by older controls. Short, sensitive, and unsupported results are intentionally skipped.

Open **Codex settings → Jev** from any screen to choose Monitor or Filter, adjust line cutoffs, control the Choice gate for long general output, test or replace the key, and open the plugin data directory. These settings apply to every session. Monitor records decisions but leaves full output visible. Filter can shorten only eligible text after the local evidence checks pass; every shortened result links to its exact original.

The **Jev** panel sits beside Output and Terminal. Reopen it through **View → Open View… → Jev: Latest decision**. It shows up to 250 judged lines from the latest batch in the active session. Blue rows were cut and gold rows were kept. The visual retention index is a display aid; hover for the underlying Jev probabilities. The panel snapshot contains bounded excerpts, not the full output.

## Verify

```bash
npm test
python3 scripts/browser_smoke.py
../hooks/bin/linux-x86_64/jevctl check-hook-trust --cwd ..
```

The browser harnesses use the real composer, settings, and panel code with synthetic, key-free data. The Codex patch must be revalidated against each new Codex extension build.

The tooltip shows the latest skip reason when no decision exists. A skipped result confirms hook activity; it does not confirm an API request. After a Codex extension update, apply the patch to the new extension directory. Each supported build has its own checked hashes and rollback directory.
