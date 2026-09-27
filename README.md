# Codex Jev

<img src="assets/logo.png" width="56" alt="Codex Jev logo">

Codex Jev trims large tool results before Codex reads them. It uses Jev to decide which repetitive lines can be omitted, keeps the exact original for recovery, and leaves uncertain results intact.

## Integrations

| Selectable integration | What Codex gets |
| --- | --- |
| Output filter | A shorter excerpt of repetitive tool output. |
| Test/build logs | Failures and completion summaries without routine pass and progress lines. |
| Search/listing | Relevant matches and representative file paths from broad results. |

All integrations start off. The button in the Codex composer selects them and shows Jev health and recent outcomes. The composer images show synthetic activity from the current control.

<img src="docs/images/jev-menu.png" width="620" alt="Jev integrations selector in the Codex composer">

## Settings

Selecting a Jev integration without a key opens **Connect Jev** over the Codex side window. Its solid backdrop hides the current chats, and a link below the buttons opens the typesafe.ai homepage in the system browser. You can test and save the key in Connect Jev, or choose **Skip for now** and reopen setup from the Jev menu or the compact missing-key tooltip. Open **Codex settings → Jev**, below **Voice**, to test or replace the key, view lifetime savings and activity, open the session logs in Explorer, or change the integration cutoffs with visible sliders and percentage fields. Short descriptions under the filter headings explain what each one trims. Enter a whole percentage with or without `%`; the field adds `%` when it loses focus. Out-of-range values restore the last valid slider value. The saved key mask matches its length without sending the key to the webview. **Never delete logs** saves immediately and disables the MB limit. **Reset defaults**, at the right of the action row, stages the default mode, cutoffs, decision methods, and 50 MB log limit until you select **Save settings**. It leaves the API key and integration selections intact. Output and test/build use Noul and Choice by default; search/listing uses Choice. Disable a method with its checkbox. A filter with all methods off leaves output unchanged. Score is not used by these filters. **Monitor** previews decisions in the logs and leaves tool output unchanged. **Filter** shortens approved results. Changes apply to the next tool result. The captures show example state and contain no key.

Each Jev request gets a private JSON receipt under `PLUGIN_DATA/logs/YYYY-MM-DD-<session-hash>/`. Its filename includes the UTC time. The receipt records the original and visible result, request, answer, decision, and chunk position. Logs have a 50 MB default limit; the oldest files are removed first. Set 1–9999 MB in **Log retention**, or select **Never delete logs** to disable cleanup. The limit applies to session logs and receipts; originals referenced by shortened tool output stay under `PLUGIN_DATA/outputs/` until removed separately.

<img src="docs/images/jev-onboarding.png" width="520" alt="Connect Jev API key setup with a solid backdrop, Save and Skip buttons, and a TypeSafe API key link">

<img src="docs/images/jev-missing-key.png" width="340" alt="Compact Jev tooltip with a Connect button when no API key is saved">

<img src="docs/images/jev-settings.png" width="900" alt="Illustrative Jev settings with log retention, slider tracks, percentage fields, and right aligned Reset defaults">

## Measured results

A [live hook benchmark](docs/benchmarks/benchmark_live_2026-09-26.md) ran the three integrations over real command output with 30 Jev calls. Token counts use `o200k_base`.

| Integration | Replaced results | Model-visible tokens saved | Reduction on replaced results |
| --- | ---: | ---: | ---: |
| Output filter | 9 | 48,886 | 95.3% |
| Test/build logs | 12 | 13,475 | **90.0%** |
| Search/listing | 3 | 8,346 | 71.3% |

Across all 36 results, including oversized inputs that the hook deliberately skipped, the integrations saved **70,707 model-visible tokens**. These are tool-output measurements, not billed-token or full-task savings. Jev kept all six search-hit outputs when it was uncertain.

<img src="docs/images/jev-tooltip.png" width="620" alt="Jev activity and savings shown in the Codex composer">

## Quick install

```bash
codex plugin marketplace add https://github.com/PhilippElhaus/Codex-Jev
codex plugin add codex-jev@codex-jev
```

Build the [VS Code control VSIX](vscode-control/README.md) and install `codex-jev-control-0.2.17.vsix`. Set `codexJev.dataDirectory` to the plugin data directory, and apply the version-pinned composer patch. Enable an integration to open key setup when no key is saved. Start a new Codex thread.

## Documentation

- [Installation](docs/setup/setup_installation.md), [credentials](docs/setup/setup_credentials.md), and [migration](docs/setup/setup_migration.md)
- [Integration design](docs/architecture/design_integrations.md) and [data handling](docs/architecture/design_data.md)
- [VS Code control](docs/architecture/design_vscode.md)
- [Benchmarks](docs/benchmarks/benchmark_live_2026-09-26.md), [test map](tests/README.md), and [verification](docs/development/development_verification.md)
