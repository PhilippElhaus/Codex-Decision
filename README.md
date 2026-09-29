# Codex Jev

<img src="assets/logo.png" width="56" alt="Codex Jev logo">

Codex Jev uses a Rust PostToolUse hook to judge eligible output one physical line at a time. It keeps exact source text for retained lines and a path to the full original. Uncertain results stay intact.

## How it works

The hook sends bounded batches of eligible lines to Jev. Each judged line receives two independent Noul probabilities: **Can omit?** and **Exact text needed?** Search results also receive **Task relevant?**. With the default policy, a line can be removed only when the first two probabilities reach at least 95% and at most 5%, respectively. The search relevance guard starts in preview mode and can be enabled to keep potentially useful matches. Code protects diagnostics, completion totals, nearby context, and unjudged lines before asking Jev. If a request fails validation, Codex sees the full result.

The optional **Jev** panel beside Output and Terminal shows five recent judged lines, the latest source excerpt, and animated full-block probability bars. It stays empty until a real decision arrives.

<img src="docs/images/jev-panel.png" width="1000" alt="Jev panel rendered from the current extension webview with synthetic line judgments and search relevance probability bars">

## What it filters

| Integration | Kept in Codex's context |
| --- | --- |
| Output filter | Exact retained source lines and an omission map. |
| Test/build logs | Exact retained lines, with diagnostics and completion totals protected. |
| Search/listing | Exact retained matches or paths, including `rg --json` records. |

All three start disabled. **Monitor** records decisions without changing output. **Filter** shortens approved results. A shortened result links to its saved original. Eligible text reaches [TypeSafe AI's Jev API](docs/architecture/design_data.md); keep sensitive output outside these filters.

<img src="docs/images/jev-menu.png" width="620" alt="Jev integration selector in the Codex composer">

## Setup and settings

1. [Install the plugin](docs/setup/setup_installation.md). The optional [VS Code control](vscode-control/README.md) adds the composer menu and settings page.
2. Enable an integration. **Connect Jev** asks for a typesafe.ai API key; test and save it there. Do not enter the key in chat.
3. Open **Codex settings → Jev** to select Monitor or Filter, adjust cutoffs, test or replace the key, and open logs. Changes apply to the next tool result.

<img src="docs/images/jev-connect.png" width="900" alt="Illustrative Connect Jev API key screen beside the Codex sign-in view; example state with no key">

<img src="docs/images/jev-settings-overview.png" width="850" alt="Jev settings page showing line counts, API key, log retention, and Monitor or Filter mode">

<img src="docs/images/jev-settings-filters.png" width="850" alt="Jev settings showing per-line omission thresholds and the optional search relevance guard">

These captures render the current webview code with synthetic, key-free state.

## Install

```bash
codex plugin marketplace add https://github.com/PhilippElhaus/Codex-Jev
codex plugin add codex-jev@codex-jev
```

The bundled Linux x86_64 Rust hook needs no Python at runtime. The `jev-output` skill helps configure the filters and check shortened evidence. The optional VS Code control requires a [version-pinned Codex patch](vscode-control/README.md).

## More detail

- [Key setup](docs/setup/setup_credentials.md) and [data handling](docs/architecture/design_data.md)
- [Integration design](docs/architecture/design_integrations.md) and [verification](docs/development/development_verification.md)
- [Test map](tests/README.md). The [2026-09-26 benchmark](docs/benchmarks/benchmark_live_2026-09-26.md) measured a previous implementation and does not measure this release.
