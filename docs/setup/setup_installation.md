# Install and verify

For Windows VS Code with Linux x86_64 WSL, install the integrated VSIX from the [latest release](https://github.com/PhilippElhaus/Codex-Decision/releases/latest):

```bash
code --install-extension codex-decision-0.14.0.vsix --force
```

This single package contains the hook, skill, session controls, settings, and verified composer patch. Activation updates an existing local plugin without changing its identity or data directory. A fresh install registers the bundled local marketplace. The installer preserves credentials, settings, session flags, saved originals, and Codex hook trust records. It rejects ambiguous plugin registrations instead of creating a duplicate hook.

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
