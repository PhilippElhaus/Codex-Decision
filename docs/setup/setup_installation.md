# Install and verify

Download the integrated VSIX from the [latest release](https://github.com/PhilippElhaus/Codex-Decision/releases/latest). In **Visual Studio Code** on Windows x86_64, open **Extensions** (`Ctrl+Shift+X`), select **… → Install from VSIX…**, and choose `codex-decision-0.15.2.vsix`.

If double-clicking the file opens **Visual Studio VSIX Installer**, close that installer and use the VS Code menu. You can also install from a terminal:

```bash
code --install-extension codex-decision-0.15.2.vsix --force
```

This single package contains Windows x86_64 and Linux x86_64 hooks, the skill, session controls, settings, and verified composer patch. It follows Codex’s `chatgpt.runCodexInWindowsSubsystemForLinux` setting. Native Windows needs no WSL or Python. The WSL backend keeps its own registration and data. Automatically discovered data directories follow the selected Codex runtime. Each runtime retains its own settings and credentials. A successful repair adopts an existing canonical data directory for automatic runtime switching. Mismatched overrides stay unchanged. If they point to another runtime, clear `codexDecision.dataDirectory` and run **Decision: Repair Integration**. Activation updates an existing local plugin without changing its identity or data directory. A fresh install registers the bundled local marketplace. The installer preserves credentials, settings, session flags, saved originals, and Codex hook trust records. It rejects ambiguous plugin registrations instead of creating a duplicate hook.

The extension repairs supported Codex builds at startup and after extension changes. Repairs verify the build's exact files and keep rollback copies outside the repository. Unknown or changed builds show a diagnostic. Run **Decision: Check Integration** to inspect the installation. Run **Decision: Repair Integration** to retry and reopen the panel. Run **Developer: Reload Window** after a repair.

Temporary installation failures retry after 2, 5, and 15 seconds when automatic repair is enabled. Each retry reruns installation instead of reusing a rejected startup result. Timeouts and recognized temporary access failures can retry. Invalid metadata, conflicting registrations, unsupported builds, and other deterministic refusals report immediately. The **Decision Integration** output channel names the failed phase and a safe diagnostic. It does not print private process output. Manual repair starts a fresh attempt after the underlying problem is corrected.

Each patch command waits up to 10 seconds for another Decision check or repair to release its lock. This prevents concurrent VS Code windows from reporting a busy error during normal verification. The kernel releases the lock when its process exits. If contention continues, Decision reports the diagnostic before writing any Codex files. Run **Decision: Repair Integration** to retry.

Open `/hooks` in the environment that runs your tools. Review **Codex Decision → PostToolUse** if Codex requires trust, then open a local thread. Codex binds trust to the hook definition; the integrated installer never edits its trust database. Verify the hook after an update:

```bash
decisionctl check-hook-trust --cwd /absolute/path/to/Codex-Decision
```

A successful API connection test does not establish hook activity. When enabled, the composer also reflects current hook, version, configuration, and panel faults. A current hook error or version mismatch makes it red even if the API probe succeeds. A restored receipt from an older hook version is amber until a new local result verifies the installed version. A newer successful result or intentional skip clears an older hook-error indication. The composer and Decision panel show the selected thread's same request and skip counts and current hook-activity explanation.

Check integration, hook trust, and the selected thread's enabled flag when no decisions appear. A normal local result produces a fresh hook-health record. Small, exact-source, sensitive, and unsupported outputs can skip intentionally. A classification keep already used an API request but produces no line judgments. The [current usage audit](../development/usage_effectiveness_2026-10-17.md) separates these stages and reports the observed limits.

A new local thread starts enabled. Each thread retains its later on/off choice and activity under `PLUGIN_DATA/sessions/<sha256-of-session-id>/`. Provider settings and credentials remain shared by the installation. Windows WSL directories use `700` and configuration files use `600`. After one minute without a receipt, the control reports missing hook activity.

Code-mode hooks act on nested tools. Decision's `continue: false` feedback does not reject the JavaScript tool promise, so a script can still print its original return value. A saved replacement receipt does not establish model-context reduction. See the [official code-mode hook contract](https://learn.chatgpt.com/docs/hooks#tool-calls-from-code-mode).

Build the integrated package with `./scripts/build_control.sh`. Generated packages stay in `.local/submission/`. See the [control guide](../../vscode-control/README.md) for supported builds, automatic repair, and rollback.

## Recover after a Codex update

Decision `0.14.1` reports `unsupported Codex extension version` for Codex `26.1021.22027`. Support for that Codex build starts in Decision `0.15.0`. The compatibility checker belongs to the installed **VS Code extension**. Updating only the Codex plugin does not update that checker.

1. Install the latest Decision VSIX through **Extensions → … → Install from VSIX…** in VS Code on the affected machine.
2. Run **Developer: Reload Window** to load the new extension.
3. Run **Decision: Repair Integration**.
4. Reload the window after a successful repair.
5. Run **Decision: Check Integration** and confirm that it reports `ready`.

Decision `0.15.1` logs the loaded control and bundled hook versions at the start of the **Decision Integration** output channel. Its control is `0.15.1`; its bundled hook remains `0.15.0`. An unsupported-version refusal also shows the update steps. Unknown or modified Codex builds still require a verified patch profile.

A `WSL path conversion` failure followed by an unsupported-version message means that a retry reached the checker. Resolve the version mismatch first. If path conversion continues to fail, check the selected WSL distribution before running repair again. Keep Codex's Windows/WSL setting aligned with the runtime you use; changing runtimes selects a separate Decision data store.

Codex's `could not start its user interface` message is a separate renderer-startup failure. Decision's unsupported-version check refuses before it writes any Codex files. If the UI still fails after the update and repair, inspect the **Codex** output channel and **Developer: Open Webview Developer Tools** for the first renderer error. Preserve the rollback directory and plugin data. Do not remove credentials or chat history to troubleshoot this message.

## GitHub updates

Decision `0.15.1` adds automatic updates from this repository's public GitHub Releases. No Marketplace listing or GitHub sign-in is required. Install the VSIX once on each older machine to enable the updater.

The installed control checks for a newer stable release at startup when the previous check is at least 24 hours old. It also checks while VS Code stays open. It downloads the matching `codex-decision-<version>.vsix`, verifies its size and GitHub's SHA-256 digest, and passes the local package to VS Code's extension installer. A successful update offers **Reload Window**. The updater does not force a reload during your work. Normal activation after reload updates the bundled hook and repairs supported Codex builds.

Run **Decision: Check for Updates** to bypass the daily interval. Disable `codexDecision.autoUpdate` in user settings to stop automatic checks and installation. The manual command still works. Development and extension-test instances do not check automatically. Prereleases, older versions, missing assets, and invalid downloads are not installed. The **Decision Updates** output channel reports update status. An offline or rate-limited background check leaves the current installation in place.

Update requests go to the fixed GitHub repository and GitHub's release-asset hosts. They do not include chat content, tool output, provider credentials, or a GitHub token. See [data handling](../architecture/design_data.md).

## Standalone CLI

Linux x86_64 CLI users can install the hook without VS Code:

```bash
codex plugin marketplace add https://github.com/PhilippElhaus/Codex-Decision
codex plugin add codex-decision@codex-decision
```

Build its ZIP with `./scripts/build_submission.sh`. A registered local marketplace uses its own source directory. Update that source from the package before running `codex plugin add`; preserve the previous package for rollback. `codex plugin marketplace upgrade` refreshes Git marketplaces.

Without the session control, enable the hook explicitly. To opt into installation-wide filtering, add `"scope": "global"` to schema-5 `PLUGIN_DATA/config.json` and set `"enabled": true`. A session config overrides this global choice. [config.example.json](../../config.example.json) shows the fields.

Legacy schema-2/3/4 configs and schema-1/2/3 shared settings migrate when read. Any enabled old switch enables Decision. Migration preserves stricter relevance bounds and starts at no more than 5%. The next save writes the current schema.

## Upgrade from Codex Jev

The plugin ID is now `codex-decision`; the control ID is `elhaus-labs.codex-decision-control`. Keep the previous package, plugin data, and composer rollback files until the new installation is verified. Install the integrated package, then disable the old plugin and uninstall the old control to prevent duplicate hooks and panels.

Preserve session settings, logs, statistics, and saved originals when copying data to the new plugin data directory. Existing receipts can point to the old directory, so retain that directory. Add the OpenAI key with `decisionctl set-key`, then explicitly select OpenAI in shared settings. Legacy configurations retain TypeSafe by design. Set `codexDecision.dataDirectory` to the new installed directory.

An older composer patch uses the old control command and asset names. Restore it with its matching preserved `jevctl` and rollback directory before applying the new patch. Do not overwrite old rollback metadata. For an unpatched supported Codex build, apply the new patch directly with a separate `codex-decision/rollback/<version>` directory.

Reload VS Code and start a new thread. Review the renamed hook in `/hooks`; its new definition requires a new trust review. Run `decisionctl check-hook-trust` and an eligible local smoke command before considering hook activation complete.
