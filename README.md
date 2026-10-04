# Codex Jev

<img src="assets/logo.png" width="56" alt="Codex Jev logo">

Codex Jev removes repetitive lines from local tool output before Codex reads them. Errors and useful evidence stay visible. Every shortened result links to the complete original.

**Jev 0.10.7 · VS Code control 0.9.10** — [Download the latest release](https://github.com/PhilippElhaus/Codex-Jev/releases/tag/v0.10.7).

## Get started

Install the plugin on Linux x86_64:

```bash
codex plugin marketplace add https://github.com/PhilippElhaus/Codex-Jev
codex plugin add codex-jev@codex-jev
```

Trust the Jev hook in `/hooks`. For the screens below, install the optional [VS Code control and composer patch](vscode-control/README.md#install). Run **Developer: Reload Window**, then start a new local Codex thread. See [installation and upgrades](docs/setup/setup_installation.md) for details.

### 1. Connect Jev

Sign in to Codex, then enter and test your typesafe.ai API key in **Connect Jev**. The key stays out of chat.

<img src="docs/images/jev-connect.png" width="760" alt="Connect Jev screen with an empty API key field">

### 2. Turn Jev on or off

Click **jev** in the composer. Each thread remembers its choice. Eligible output is sent to TypeSafe while Jev is enabled.

<img src="docs/images/jev-toggle.png" width="620" alt="Jev on/off button on the Codex composer toolbar">

### 3. Adjust the details

Open **Codex settings → Jev** to choose **Monitor** (keep full output) or **Filter** (shorten approved output). Manage the relevance cutoff, API key, and log retention here. Settings apply to all sessions.

<img src="docs/images/jev-settings-overview.png" width="760" alt="Jev settings showing activity, API key controls, and log retention">

### 4. Inspect a result

Open the **Jev** panel beside **Terminal** and **Output**. Blue rows mark proposed omissions; gold rows mark kept lines. Bars show relevance. Hover for excerpts and reasons. Before the first decision, the panel shows hook activity and skip reasons.

<img src="docs/images/jev-panel.png" width="1000" alt="Jev panel showing 3 kept lines and 47 proposed omissions from a synthetic 50-line result">

Screenshots use synthetic data. For a missing decision or failed connection, see [troubleshooting](docs/setup/setup_installation.md).

## Documentation

[API key](docs/setup/setup_credentials.md) · [Filtering rules](docs/architecture/design_integrations.md) · [Privacy and safeguards](docs/architecture/design_data.md) · [Tests](tests/README.md) · [Verification report](docs/development/extensive_verification_2026-10-04.md) · [45-second Jev explainer](https://x.com/MatijaSosic/status/2100190746389135772)
