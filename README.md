# Codex Jev

<img src="assets/logo.png" width="56" alt="Codex Jev logo">

Codex Jev trims repetitive output from local tools before Codex reads it. It checks each eligible line, protects errors and other useful details, and saves the full result whenever it shortens one.

**Less noise in Codex's context.** In a [live benchmark from September 2026](docs/benchmarks/benchmark_live_2026-09-26.md), an earlier version reduced the text sent to Codex for results it shortened:

| Output | Less text sent to Codex |
| --- | ---: |
| Regular tool output | 95% |
| Test and build logs | 90% |
| Search results and file listings | 71% |

Measured as tokens. The full stress-test mix fell by 3%, including oversized results that Jev skipped. These figures describe the earlier version, not a benchmark of the current line-by-line release or a complete coding task.

## Get started

Install the plugin on Linux x86_64:

```bash
codex plugin marketplace add https://github.com/PhilippElhaus/Codex-Jev
codex plugin add codex-jev@codex-jev
```

The screens below use the optional [VS Code control](vscode-control/README.md), which needs a [version-pinned Codex patch](vscode-control/README.md#install). The screenshots use example data and contain no real API key.

### 1. Connect Jev

Sign in to Codex. When you first turn on a Jev integration, **Connect Jev** asks for a typesafe.ai API key. Test and save it here; keep it out of chat.

<img src="docs/images/jev-connect.png" width="760" alt="Connect Jev screen beside the Codex sign-in screen, with an empty API key field">

### 2. Choose what to filter

Use the **jev** menu in the Codex chat box to choose regular tool output, test and build logs, or search results and file listings. All three start off. **Monitor** shows what Jev would remove; **Filter** shortens approved results.

<img src="docs/images/jev-menu.png" width="620" alt="Jev menu in the Codex chat box with three integration switches">

### 3. Adjust settings in Codex

Open **Codex settings → Jev** to change the mode, review activity, manage the key, or open saved logs. Lower on the same page, you can adjust when each filter removes a line. Changes apply to the next tool result.

<img src="docs/images/jev-settings-overview.png" width="760" alt="Codex Jev settings showing activity, API key controls, and log options">

<img src="docs/images/jev-settings-filters.png" width="760" alt="Jev settings for filter mode and line removal thresholds">

### 4. See what Jev kept

The optional **Jev** panel beside Output and Terminal shows the latest decision. Blue lines were omitted; gold lines were kept. This example keeps 3 of 50 lines. When Jev shortens a result, Codex gets the kept text and a path to the complete original.

<img src="docs/images/jev-panel.png" width="1000" alt="Jev panel showing 3 kept lines and 47 omitted lines from a synthetic 50-line result">

## More detail

- [Installation and upgrades](docs/setup/setup_installation.md) · [API key setup](docs/setup/setup_credentials.md)
- [What each filter handles](docs/architecture/design_integrations.md) · [Data handling and safeguards](docs/architecture/design_data.md)
- [Verification and tests](docs/development/development_verification.md) · [Full benchmark results](docs/benchmarks/benchmark_live_2026-09-26.md)
