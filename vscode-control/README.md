# Codex Decision for VS Code

The integrated extension contains the native Decision hook, skill, composer control, settings, and bottom panel. Windows runs the native x86_64 hook by default. Codex's WSL execution setting selects the Linux x86_64 runtime and its own data store.

Install the release VSIX through **Extensions → … → Install from VSIX…** in Visual Studio Code. Reload after integration repair. Review the current hook in `/hooks` when Codex requires trust. Use **Decision: Check Integration** for diagnostics and **Decision: Repair Integration** to retry or reopen the panel.

Connect through OpenAI Decisions, TypeSafe Jev, or a compatible custom endpoint. Saved secrets stay private. Click **decision** to change the selected thread. Settings apply to the installation. The panel provides Latest, Totals, and optional local skipped-output capture.

Unknown or changed Codex assets are refused before patching. Repairs preserve runtime rollback copies and cached paths needed by existing threads. Start a new thread to load an updated hook. Automatic stable-release updates verify size and SHA-256, then offer a reload. Disable `codexDecision.autoUpdate` for manual checks.

Prepared hook output does not establish delivered context or token savings. Code-mode wrappers can still print original nested results.

Current guides:

- [Context ranking and Codex MCP registration](https://github.com/PhilippElhaus/Codex-Decision/blob/main/docs/reference/context-ranking.md)
- [Failure triage in Test Explorer](https://github.com/PhilippElhaus/Codex-Decision/blob/main/docs/reference/failure-triage.md)
- [Opt-in completion verification](https://github.com/PhilippElhaus/Codex-Decision/blob/main/docs/reference/completion-verification.md)

- [Install and recover](https://github.com/PhilippElhaus/Codex-Decision/blob/main/docs/setup/installation.md)
- [Configure providers](https://github.com/PhilippElhaus/Codex-Decision/blob/main/docs/setup/providers.md)
- [Use the composer and panel](https://github.com/PhilippElhaus/Codex-Decision/blob/main/docs/reference/usage.md)
- [Privacy](https://github.com/PhilippElhaus/Codex-Decision/blob/main/docs/reference/privacy.md)
- [VS Code architecture and supported patch profiles](https://github.com/PhilippElhaus/Codex-Decision/blob/main/docs/architecture/vscode.md)
- [Measure effectiveness](https://github.com/PhilippElhaus/Codex-Decision/blob/main/docs/operations/measurement.md)
- [Build and verify](https://github.com/PhilippElhaus/Codex-Decision/blob/main/docs/development/builds.md)

From this directory, `npm test` runs the existing Node suite. Repository-level Nx commands and function-coverage collection are documented in the [test guide](https://github.com/PhilippElhaus/Codex-Decision/blob/main/tests/README.md).
