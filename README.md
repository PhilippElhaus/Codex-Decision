# Codex Jev

<img src="assets/logo.png" width="56" alt="Codex Jev logo">

Codex Jev shortens noisy tool results before Codex reads them. It keeps selected evidence and a path to the exact original. Uncertain results stay intact.

## Measured impact

A [live hook benchmark from 2026-09-26](docs/benchmarks/benchmark_live_2026-09-26.md) used 36 real command results and 30 Jev calls. The measurements cover an earlier filter implementation; [current evidence-selection changes](docs/benchmarks/benchmark_offline_2026-09-27.md) have offline verification.

| Integration | Results shortened | Model-visible tokens saved | Reduction on shortened results |
| --- | ---: | ---: | ---: |
| Output filter | 9 | 48,886 | 95.3% |
| Test/build logs | 12 | 13,475 | 90.0% |
| Search/listing | 3 | 8,346 | 71.3% |
| **Total** | **24** | **70,707** | — |

Counts use `o200k_base` on tool text. They are not billed-token or full-task savings. Jev kept six search-hit results when uncertain; six other results were skipped by local checks.

## What it filters

| Integration | Kept in Codex's context |
| --- | --- |
| Output filter | Relevant source lines, original line numbers, and an omission map. |
| Test/build logs | Failures and summaries instead of routine pass and progress lines. |
| Search/listing | Relevant matches and file leads from broad results, including `rg --json`. |

All three start disabled. **Monitor** records decisions without changing output. **Filter** shortens approved results. A shortened result links to its saved original. Eligible text reaches [TypeSafe AI's Jev API](docs/architecture/design_data.md); keep sensitive output outside these filters.

<img src="docs/images/jev-menu.png" width="620" alt="Jev integration selector in the Codex composer">

## Setup and settings

1. [Install the plugin](docs/setup/setup_installation.md). The optional [VS Code control](vscode-control/README.md) adds the composer menu and settings page.
2. Enable an integration. **Connect Jev** asks for a typesafe.ai API key; test and save it there. Do not enter the key in chat.
3. Open **Codex settings → Jev** to select Monitor or Filter, adjust cutoffs, test or replace the key, and open logs. Changes apply to the next tool result.

<img src="docs/images/jev-connect.png" width="900" alt="Illustrative Connect Jev API key screen beside the Codex sign-in view; example state with no key">

<img src="docs/images/jev-settings-overview.png" width="850" alt="Jev settings page showing activity, API key, log retention, and mode">

<img src="docs/images/jev-settings-filters.png" width="850" alt="Jev settings page showing filter methods and cutoffs">

The captures use synthetic state and contain no key. The [full settings capture](docs/images/jev-settings.png) shows all three integrations.

## Install

```bash
codex plugin marketplace add https://github.com/PhilippElhaus/Codex-Jev
codex plugin add codex-jev@codex-jev
```

The bundled `jev-output` skill helps configure the filters and check shortened evidence. The [public directory submission](docs/submission/README.md) is prepared separately. The VS Code control requires a [version-pinned Codex patch](vscode-control/README.md).

## More detail

- [Key setup](docs/setup/setup_credentials.md) and [data handling](docs/architecture/design_data.md)
- [Integration design](docs/architecture/design_integrations.md) and [verification](docs/development/development_verification.md)
- [Benchmark methods](docs/benchmarks/benchmark_live_2026-09-26.md) and [test map](tests/README.md)
