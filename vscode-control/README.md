# Codex Decision control for VS Code

This optional extension adds one Decision on/off button to the Codex composer, detailed Decision settings, and a bottom-panel view of the latest decision. Set `codexDecision.dataDirectory` to the installed plugin's absolute `PLUGIN_DATA` path. Windows VS Code with WSL normally uses a `\\wsl.localhost\<distro>\...` path.

## Install

From this directory in WSL:

```bash
../scripts/build_control.sh
code --install-extension "$(wslpath -w ../.local/submission/codex-decision-control-0.10.8.vsix)" --force
```

The composer and Codex settings page require the separate local patch for Codex VS Code extensions `26.928.31416`, `26.930.21537`, `26.930.31730`, `26.930.41038`, `26.930.51102`, `26.930.61225`, and `26.1002.51308`. It checks exact host hashes and keeps rollback files outside this repository:

```bash
../hooks/bin/linux-x86_64/decisionctl patch-webview update --root .. \
  --extension '/mnt/c/Users/<user>/.vscode/extensions/openai.chatgpt-26.1002.51308-win32-x64' \
  --backup '/mnt/c/Users/<user>/AppData/Local/Codex/codex-decision/rollback/26.1002.51308'
```

Use `apply` for the first installation, `update` after a control upgrade, or `restore` to remove the patch. Reload VS Code after installing both pieces. Start a new Codex thread after a plugin hook upgrade and review the hook in `/hooks` again if its definition changed.

## Use

Click **decision** to turn filtering on or off for all supported tool output in the current thread. There is no integration popup. Each Codex session has its own enabled flag, decisions, counters, and hook status. The pinned patch reads the active session ID from Codex's internal router, even when the webview URL does not change. State lives under `PLUGIN_DATA/sessions/<session-hash>/`; a new local session starts enabled, and later choices are preserved. On the home screen, the button is disabled until a thread opens. A local thread with an unreadable ID cannot change another session's state. The API key in `PLUGIN_DATA/.env` and behavior settings in `PLUGIN_DATA/settings.json` are shared across this installation.

Legacy schema-2/3/4 session configs and schema-1/2/3 shared settings remain readable. Any enabled old switch enables Decision. Migration starts with a relevance cutoff no higher than 5% and preserves stricter old bounds. The next save writes schema 5 for the session or schema 4 for shared settings. Known formats use local validation. Unknown formats keep the conservative classification gate. The old gate switch is retired.

Each open Codex view keeps its own control state. A home view or another thread in the same VS Code window cannot reset the active thread's color, counters, or selection. Older status replies cannot replace newer ones. Each selection waits for its host acknowledgement before accepting another click. If the host does not reply within ten seconds, the activity tooltip reports the connection failure and the control offers Retry.

When enabled, the indicator is green after a small successful Decision API request, red on a missing key or failed request, and amber while that check is pending. The button is gray when off or without a thread. API checks continue in both states. The activity tooltip is hidden on the home screen. Hook and session errors appear in the tooltip during a thread. An API check does not verify hook trust; review `/hooks` after installing or updating the hook. After a minute without a hook receipt, the tooltip explains how to check the hook. Windows WSL paths receive private Linux permissions, including existing session folders created by older controls. Short, sensitive, and unsupported results are intentionally skipped.

Open **Codex settings → Decision** from any screen to choose Monitor or Filter, adjust the shared relevance cutoff, test or replace the key, and open the plugin data directory. These settings apply to every session. Monitor records decisions but leaves full output visible. Filter can shorten only eligible text after the local evidence checks pass; every shortened result links to its exact original.

The **Decision** panel sits beside Output and Terminal. **Latest** shows the selected thread’s latest line decision. **Totals** shows its saved output, request, evaluation, removal, and skip-reason counts. The selected view survives a reload and stays selected when you switch threads. API attempts and completion counters are restored from the same thread records in the panel and composer; they do not reset when you return to a thread. The settings page’s **All sessions** summary aggregates those same request attempts, including pending and failed requests. Reopen it through **View → Open View… → Decision: Latest decision**. It shows every line from the latest result in the active session, including protected lines and cumulative judgments from all batches. The sticky header shows removed/total lines after filtering, or proposed removals for a preview. Its upper-right corner always shows this thread’s API request and skipped-output counts. The counts refresh while a decision is displayed, without restarting the line animation. Blue rows were cut and gold rows were kept. The selected thread's latest decision remains available after reloading VS Code. Switching threads refreshes the panel immediately. Line rows appear after the first relevance batch; a classification that keeps the full output produces no line rows. Check the composer tooltip for the latest skip reason and hook health. Judged rows show the actual Decision task-relevance probability. Protected and pending rows show an em dash and explain why they are kept. Historical rows use a visual retention index; hover for their recorded probabilities. The panel snapshot contains bounded excerpts, not the full output.

## Verify

The control packs each judged line into a single row. A ten-character bar and a 0–100% value show its score. Columns adapt to the panel width. Hover for the full excerpt, precise probability, and reason. Known command envelopes in code-mode `exec` and `wait` can be shortened. Metadata stays protected, and a complete typed original is saved. The panel labels previews explicitly.

```bash
npm test
python3 scripts/browser_smoke.py
../hooks/bin/linux-x86_64/decisionctl check-hook-trust --cwd ..
```

The browser harnesses use the real composer, settings, and panel code with synthetic, key-free data. The Codex patch must be revalidated against each new Codex extension build.

The header keeps this thread's API request and skipped-output counts visible before and after line decisions. API requests count hook attempts, including pending or failed requests, and exclude the separate connection check. Older sessions retain their recorded count at upgrade. The empty panel explains the latest skip or hook error. A classification that keeps full output is reported explicitly. The tooltip also shows the latest skip reason. A skipped result confirms hook activity; it does not confirm an API request. After a Codex extension update, apply the patch to the new extension directory. Each supported build has its own checked hashes and rollback directory.

The composer briefly glows blue once at the start of output evaluation. Relevance calls, batch completions, and API connection checks do not flash. Each start is consumed once per view, so repeated status replies cannot restart the pulse.

The composer keeps its indicator on the toolbar row. Tight gaps reduce its padding and show only the dot. If the controls leave less than 11 px, the indicator hides until space returns. It never moves over the prompt.
