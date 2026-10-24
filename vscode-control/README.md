# Codex Decision control for VS Code

This integrated extension contains the local Decision hook, skill, composer control, settings, and bottom-panel view. Windows VS Code runs the native Windows x86_64 hook by default. It uses the Linux x86_64 hook when Codex runs in WSL. Existing Decision data and per-thread choices remain in place.

## Install

Install the release VSIX in Windows VS Code. To build the combined package, first build the native Windows binaries with `scripts/build_hook_windows.ps1`, then build and package from Linux or WSL:

```bash
../scripts/build_control.sh
code --install-extension "$(wslpath -w ../.local/submission/codex-decision-0.15.0.vsix)" --force
```

On activation, the package installs or updates the bundled Codex plugin and checks the Codex UI integration. It follows `chatgpt.runCodexInWindowsSubsystemForLinux` and uses a matching native or WSL data directory. Native Windows needs no Python or WSL. WSL uses its own plugin registration and data. It sets `codexDecision.dataDirectory` when that setting is empty. Automatically discovered data directories follow the selected Codex runtime. Each runtime retains its own settings and credentials. A successful repair adopts an existing canonical data directory for automatic runtime switching. Mismatched overrides stay unchanged. If they point to another runtime, clear `codexDecision.dataDirectory` and run **Decision: Repair Integration**. Existing plugin identity, credentials, logs, and thread settings remain in place.

The integrated patch supports Codex builds `26.928.31416`, `26.930.21537`, `26.930.31730`, `26.930.41038`, `26.930.51102`, `26.930.61225`, `26.1002.51308`, `26.1007.21434`, and `26.1021.22027`. It verifies exact host hashes, serializes repairs, and retains rollback files under the user's local Codex directory. Unknown or modified builds produce a diagnostic and remain unchanged. A healthy patch causes no rewrite.

After the repair, run **Developer: Reload Window**. Open a local Codex thread. Review the hook in `/hooks` if its definition needs trust; the installer does not edit Codex trust records.

Use **Decision: Check Integration** to inspect the installed build. Use **Decision: Repair Integration** to retry and reopen the Decision panel. Automatic repair runs at startup and after a Codex extension change. Set `codexDecision.autoRepairIntegration` to `false` to use manual repair only. No separate plugin ZIP or manual patch command is required.

Temporary WSL or installer access failures receive three automatic retries after 2, 5, and 15 seconds. A successful retry ends recovery. Disposal or disabling automatic repair cancels pending retries. Deterministic configuration, permission, and security refusals do not retry. Diagnostics identify a bounded installation phase and failure category without forwarding OS paths or child-process output.

## Rollback

Keep the previous complete package and the per-build patch rollback directory. Reinstalling an older VSIX replaces the control, but the installer deliberately refuses to downgrade a newer hook. Hook rollback needs a verified restoration of the prior package and Codex registration; no automatic downgrade command is provided. The integrated source backups contain only changed files and are not a complete installation restore. Restore a composer patch with its matching `decisionctl patch-webview restore` and preserved rollback directory. Preserve plugin data, credentials, saved originals, and trust records. Verify the selected plugin version and exact package bytes before using a restored control.

## Use

Connect through **OpenAI Decisions**, **TypeSafe Jev**, or **Custom provider** in onboarding or Decision settings. Custom connections accept either decision schema, a full endpoint URL, a model, and bearer, Basic, named-header, or no authentication. Saved secrets stay private and are reused only for the same endpoint and authentication identity. Custom connections do not use automatic fallback. See [provider setup](https://github.com/PhilippElhaus/Codex-Decision/blob/main/docs/setup/setup_credentials.md).

Use **Show skipped output** to capture future skips. You can change it before you open a thread. This sets the default for new threads; each thread keeps its own choice. Expand an entry to see the tool input and full response. Hover over the info button for storage details. Each new raw result stays visible for at least three seconds. Later results wait in a queue. When work ends, the panel shows a long remaining queue together. Click or focus an entry to pause live updates while you inspect it. Select **Resume live** to continue. Capture and its queue stay local, with a limit of 20 calls and 4 MiB. Older queued captures can expire while inspection is paused. Turn the switch off to stop capture.

Click **decision** to turn filtering on or off for all supported tool output in the current thread. There is no integration popup. Each Codex session has its own enabled flag, decisions, counters, and hook status. The pinned patch reads the active session ID from Codex's internal router, even when the webview URL does not change. State lives under `PLUGIN_DATA/sessions/<session-hash>/`; a new local session starts enabled, and later choices are preserved. On the home screen, the button is disabled until a thread opens. A local thread with an unreadable ID cannot change another session's state. The API key in `PLUGIN_DATA/.env` and behavior settings in `PLUGIN_DATA/settings.json` are shared across this installation.

Legacy schema-2/3/4 session configs and schema-1/2/3 shared settings remain readable. Any enabled old switch enables Decision. Migration starts with a relevance cutoff no higher than 5% and preserves stricter old bounds. The next save writes schema 5 for the session or schema 4 for shared settings. Known formats use local validation. Unknown formats keep the conservative classification gate. The old gate switch is retired.

Each open Codex view keeps its own control state. A home view or another thread in the same VS Code window cannot reset the active thread's color, counters, or selection. Older status replies cannot replace newer ones. Each selection waits for its host acknowledgement before accepting another click. If the host does not reply within ten seconds, the activity tooltip reports the connection failure and the control offers Retry.

When enabled, the indicator reflects API and hook health. It is green when healthy, red for an API, hook, configuration, or view failure, and amber while checking or waiting for verification. The button is gray when off or without a thread. API checks continue in both states and have a separate tooltip label. A newer normal skip or successful evaluation clears an older hook error. Saved same-version activity survives a reload. An earlier-version receipt requests verification in amber; a fresh mismatched receipt reports failure. An API check does not verify hook trust; review `/hooks` after installing or updating the hook. After a minute without recorded hook activity, the tooltip explains recovery. Windows WSL paths receive private Linux permissions, including existing session folders created by older controls. Short, sensitive, and unsupported results are intentionally skipped.

Open **Codex settings → Decision** from any screen to choose Monitor or Filter, adjust the shared relevance cutoff, save and test each provider’s key, switch providers, and open the plugin data directory. Blank key fields preserve saved keys. **Use the other provider if needed** enables one fallback after a missing primary key or a provider failure. It starts off; enabling it permits eligible text to reach either provider. Local safety and storage failures never trigger fallback. These settings apply to every session. Monitor records decisions but leaves full output visible. Filter can shorten only eligible text after the local evidence checks pass; every shortened result links to its exact original.

The **Decision** panel sits beside Output and Terminal. **Latest** shows the selected thread’s latest line decision. **Totals** shows its saved output, request, evaluation, removal, and skip-reason counts. The selected view survives a reload and stays selected when you switch threads. API attempts and completion counters are restored from the same thread records in the panel and composer; they do not reset when you return to a thread. The settings page’s **All sessions** summary aggregates those same request attempts, including pending and failed requests. Reopen it through **View → Open View… → Decision: Latest decision**. It shows every line from the latest result in the active session, including protected lines and cumulative judgments from all batches. The sticky header shows removed/total lines after filtering, or proposed removals for a preview. Its upper-right corner always shows this thread’s API request and skipped-output counts. The counts refresh while a decision is displayed, without restarting the line animation. Blue rows were cut and gold rows were kept. The selected thread's latest decision remains available after reloading VS Code. Switching threads refreshes the panel immediately. Line rows appear after the first relevance batch; a classification that keeps the full output produces no line rows. Check the composer tooltip for the latest skip reason and hook health. Judged rows show the actual Decision task-relevance probability. Protected and pending rows show an em dash and explain why they are kept. Historical rows use a visual retention index; hover for their recorded probabilities. The panel snapshot contains bounded excerpts, not the full output. Replacements and payload estimates describe the hook’s committed output. The UI marks consumer delivery as unverified because code-mode wrappers can still return the original result. These counts do not establish context reduction or billed-token savings.

## Verify

The control packs each judged line into a single row. A ten-character bar and a 0–100% value show its score. Columns adapt to the panel width. Hover for the full excerpt, precise probability, and reason. Known command envelopes in code-mode `exec` and `wait` can be shortened. Metadata stays protected, and a complete typed original is saved. The panel labels previews explicitly.

Version 0.13.0 also validates matching duplicate command envelopes and serialized
homogeneous command-result batches, including fulfilled `Promise.allSettled`
results. Each member retains metadata and output boundaries. Unknown or rejected
members, mismatched duplicates, mixed media, and coupled structures keep the
complete batch. Passing Cargo test names and exact zero-valued diagnostic
counters can reach relevance judgments while real diagnostics stay protected.

```bash
npm test
python3 scripts/browser_smoke.py
../hooks/bin/linux-x86_64/decisionctl check-hook-trust --cwd ..
```

The browser harnesses use the real composer, settings, and panel code with synthetic, key-free data. Each new Codex build requires a verified patch profile. Unsupported updates are reported instead of silently losing the integration.

The header keeps this thread's API request and skipped-output counts visible before and after line decisions. API requests count hook attempts, including pending or failed requests, and exclude the separate connection check. Older sessions retain their recorded count at upgrade. The empty panel explains the latest skip or hook error. A classification that keeps full output is reported explicitly. The tooltip also shows the latest skip reason. A skipped result confirms hook activity; it does not confirm an API request. After a Codex extension update, apply the patch to the new extension directory. Each supported build has its own checked hashes and rollback directory.

The composer briefly glows blue once at the start of output evaluation. Relevance calls, batch completions, and API connection checks do not flash. Each start is consumed once per view, so repeated status replies cannot restart the pulse.

The composer keeps its indicator on the toolbar row. Tight gaps reduce its padding and show only the dot. If the controls leave less than 11 px, the indicator hides until space returns. It never moves over the prompt.

The composer tooltip and panel use the same latest hook outcome and saved request/skip counts. The panel displays that outcome even while retaining an earlier line evaluation. Activity updates preserve the existing rows and animation state. The indicator and tooltip sit below Codex dropdown menu layers.
