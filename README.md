# Codex Jev

<img src="assets/logo.png" width="56" alt="Codex Jev logo">

Codex Jev cuts repetitive lines from local tool output before Codex reads them. It keeps errors and useful details, and every shortened result points to a private copy of the complete original.

**What you gain:** less log noise in the conversation, a way to inspect what was kept, and clear status when the filter has not run or has failed. In a synthetic 120-line build test, the current hook omits more than 100 routine lines. Savings on real tasks depend on the output and Jev's judgments.

## Get started

On Linux x86_64, install the plugin:

```bash
codex plugin marketplace add https://github.com/PhilippElhaus/Codex-Jev
codex plugin add codex-jev@codex-jev
```

Open `/hooks` in Codex and trust the Jev hook. Do this again when an update changes the hook definition. Start a new Codex thread after installation or upgrade. The optional [VS Code control](vscode-control/README.md) adds the screens below; its composer control needs the documented patch for the supported Codex extension version.

### 1. Connect Jev

Sign in to Codex. Select a Jev filter, then enter and test your typesafe.ai API key in **Connect Jev**. The key is shared by this local installation and stays out of chat.

<img src="docs/images/jev-connect.png" width="760" alt="Connect Jev screen beside the Codex sign-in screen, with an empty API key field">

### 2. Choose a filter for this session

In the **jev** menu, choose regular output, test and build logs, or search results and listings. Each Codex session has its own switches and settings. All filters start off for a new session.

<img src="docs/images/jev-menu.png" width="620" alt="Jev menu in the Codex chat box with three integration switches">

### 3. Adjust the details

Open **Codex settings → Jev** to choose **Monitor** (show decisions, keep full output) or **Filter** (shorten approved output). You can also review this session's activity, change its cutoffs, or open its logs. For long general output, a Jev choice check can decide whether line filtering is useful; uncertain output stays complete. You can turn this check off in settings.

<img src="docs/images/jev-settings-overview.png" width="760" alt="Codex Jev settings showing activity, API key controls, and log options">

<img src="docs/images/jev-settings-filters.png" width="760" alt="Jev settings for filter mode and line removal thresholds">

### 4. Inspect a result

The **Jev** panel shows the latest decision from this session. Blue lines were cut; gold lines were kept. This synthetic example keeps 3 of 50 lines. A shortened result also gives Codex the path to its complete original.

<img src="docs/images/jev-panel.png" width="1000" alt="Jev panel showing 3 kept lines and 47 omitted lines from a synthetic 50-line result">

The composer indicator is **amber** until the hook runs in this session, **green** after a recent hook invocation and successful API check, and **red** if the key, connection, configuration, or hook fails. A short or protected result may be skipped normally; the indicator still confirms the hook was invoked.

![Editable architecture diagram showing the Codex tool, Rust hook, local checks, Jev Choice and line checks, session data, VS Code control, and TypeSafe API](docs/images/jev-architecture.svg)

## More detail

[Install and verify](docs/setup/setup_installation.md) · [API key](docs/setup/setup_credentials.md) · [What gets filtered](docs/architecture/design_integrations.md) · [Privacy and safeguards](docs/architecture/design_data.md) · [Tests](docs/development/development_verification.md) · [45-second Jev explainer by Matija Sosić](https://x.com/MatijaSosic/status/2100190746389135772)
