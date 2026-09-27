# VS Code control

The companion extension connects the Jev button in the Codex composer to the installed plugin. The button opens three checkboxes. The menu stays open while selections change; click outside or press Escape to close it. Clear all checkboxes to turn Jev off. The extension checks Jev health and reads recent decision metadata.

The first selected integration opens a full overlay inside the Codex side window when the configured plugin data directory has no readable API key. Skip dismisses it for that window, and a Jev menu item reopens it. The entered key passes through the local Codex webview bridge to the extension for testing or storage. The settings page shows a fixed mask for a saved key and never sends that saved value back to a webview. An empty key field there tests or keeps the saved key. Test results appear beside the bordered button, with explicit reasons for invalid, expired, or unavailable connections.

The button stays on the toolbar row and beside the model control when Codex shows icon-only controls or the gap closes. Once it becomes a dot, it stays a dot as the pane gets narrower. Gray means off, green means connected, red means unavailable, and blue means a request is in progress. `OBS` marks observe mode when the full label fits. The tooltip shows activity for the current composer view, with a new view starting at zero. Recent actions show bold negative percentages for reductions. The token total estimates model-visible text saved from the removed character count using [OpenAI's rough four-characters-per-token rule](https://developers.openai.com/api/docs/concepts#tokens); it is not a billed-token count. A failed health check shows a short reason and Retry button, and the extension rechecks failed connections every 30 seconds.

![Jev unavailable tooltip with a timeout reason and Retry button](../images/jev-unavailable.png)

Set `codexJev.dataDirectory` to the installed `PLUGIN_DATA` directory. The extension has no machine-specific default. See [installation](../setup/setup_installation.md).

Codex has no supported third-party composer slot. The button needs the [version-pinned local patch](../../vscode-control/README.md) for Codex extension `26.917.62051`. The patch checks host hashes and keeps rollback files outside this repository. A Codex update can require a new patch. The Jev hook keeps the full result if its process fails.
