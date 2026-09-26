# VS Code control

The companion extension connects the Jev button in the Codex composer to the installed plugin. The button opens three checkboxes. Clear all checkboxes to turn Jev off. The extension checks Jev health and reads recent decision metadata.

The button stays on the toolbar row when Codex shows icon-only controls or the gap beside the model control closes. Once it becomes a dot, it stays a dot as the pane gets narrower. Gray means off, green means connected, red means unavailable, and blue means a request is in progress. `OBS` marks observe mode when the full label fits. The tooltip shows activity since the current composer view opened. A new view starts with empty counters.

Set `codexJev.dataDirectory` to the installed `PLUGIN_DATA` directory. The extension has no machine-specific default. See [installation](../setup/setup_installation.md).

Codex has no supported third-party composer slot. The button needs the [version-pinned local patch](../../vscode-control/README.md) for Codex extension `26.917.62051`. The patch checks host hashes and keeps rollback files outside this repository. A Codex update can require a new patch. The Jev hook keeps the full result if its process fails.
