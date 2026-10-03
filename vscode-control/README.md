# Codex Jev control for VS Code

This optional extension adds one Jev on/off button to the Codex composer, detailed Jev settings, and a bottom-panel view of the latest decision. Set `codexJev.dataDirectory` to the installed plugin's absolute `PLUGIN_DATA` path. Windows VS Code with WSL normally uses a `\\wsl.localhost\<distro>\...` path.

## Install

From this directory in WSL:

```bash
../scripts/build_control.sh
code --install-extension "$(wslpath -w ../.local/submission/codex-jev-control-0.9.2.vsix)" --force
```

The composer and Codex settings page require the separate local patch for Codex VS Code extensions `26.928.31416`, `26.930.21537`, and `26.930.31730`. It checks exact host hashes and keeps rollback files outside this repository:

```bash
../hooks/bin/linux-x86_64/jevctl patch-webview update --root .. \
  --extension '/mnt/c/Users/<user>/.vscode/extensions/openai.chatgpt-26.930.31730-win32-x64' \
  --backup '/mnt/c/Users/<user>/AppData/Local/Codex/codex-jev/rollback/26.930.31730'
```

Use `apply` for the first installation, `update` after a control upgrade, or `restore` to remove the patch. Reload VS Code after installing both pieces. Start a new Codex thread after a plugin hook upgrade and review the hook in `/hooks` again if its definition changed.

## Use

Click **jev** to turn filtering on or off for all supported tool output in the current thread. There is no integration popup. Each Codex session has its own enabled flag, decisions, counters, and hook status. The pinned patch reads the active session ID from Codex's internal router, even when the webview URL does not change. State lives under `PLUGIN_DATA/sessions/<session-hash>/`; a new local session starts enabled, and later choices are preserved. On the home screen, the button is disabled until a thread opens. A local thread with an unreadable ID cannot change another session's state. The API key in `PLUGIN_DATA/.env` and behavior settings in `PLUGIN_DATA/settings.json` are shared across this installation.

Legacy schema-2/3 session configs and schema-1/2 shared settings remain readable. Any enabled old switch enables Jev. Migration starts with a relevance cutoff no higher than 5% and preserves stricter old bounds. The next save writes schema 4 for the session or schema 3 for shared settings. Classification is mandatory; the old gate switch is retired.

Each open Codex view keeps its own control state. A home view or another thread in the same VS Code window cannot reset the active thread's color, counters, or selection. Older status replies cannot replace newer ones. Each selection waits for its host acknowledgement before accepting another click. If the host does not reply within ten seconds, the activity tooltip reports the connection failure and the control offers Retry.

When enabled, the indicator is green after a small successful Jev API request, red on a missing key or failed request, and amber while that check is pending. The button is gray when off or without a thread. API checks continue in both states. The activity tooltip is hidden on the home screen. Hook and session errors appear in the tooltip during a thread. An API check does not verify hook trust; review `/hooks` after installing or updating the hook. After a minute without a hook receipt, the tooltip explains how to check the hook. Windows WSL paths receive private Linux permissions, including existing session folders created by older controls. Short, sensitive, and unsupported results are intentionally skipped.

Open **Codex settings → Jev** from any screen to choose Monitor or Filter, adjust the shared relevance cutoff, test or replace the key, and open the plugin data directory. These settings apply to every session. Monitor records decisions but leaves full output visible. Filter can shorten only eligible text after the local evidence checks pass; every shortened result links to its exact original.

The **Jev** panel sits beside Output and Terminal. Reopen it through **View → Open View… → Jev: Latest decision**. It shows the judged lines from the latest API-bounded relevance batch in the active session, with the batch number and total batch count. Blue rows were cut and gold rows were kept. Current rows show the actual Jev task-relevance probability. Historical rows use a visual retention index; hover for their recorded probabilities. The panel snapshot contains bounded excerpts, not the full output.

## Verify

```bash
npm test
python3 scripts/browser_smoke.py
../hooks/bin/linux-x86_64/jevctl check-hook-trust --cwd ..
```

The browser harnesses use the real composer, settings, and panel code with synthetic, key-free data. The Codex patch must be revalidated against each new Codex extension build.

The tooltip shows the latest skip reason when no decision exists. A skipped result confirms hook activity; it does not confirm an API request. After a Codex extension update, apply the patch to the new extension directory. Each supported build has its own checked hashes and rollback directory.
