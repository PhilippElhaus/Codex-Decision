# Codex Jev 0.5.2 release notes

The Rust hook now publishes a bounded version 3 snapshot for the latest completed Jev batch: up to 250 judged source lines, each with its Keep/Omit result, omission probability, exact-text probability, optional search relevance, and a short excerpt. The filtering policy and private receipts are unchanged. The new snapshot contains no API key or full tool output.

VS Code control 0.4.2 shows one 0–1 full-block bar per judged line. All bars grow together over 800 ms, values fade in, and each batch rests for another second. Fast updates coalesce to the newest batch; status updates within the same batch do not restart the animation. Long batches use the panel page scroll. The dark and light captures show the current webview.

Install the plugin archive and VSIX together, then reload VS Code manually and start a new Codex thread to pick up the hook. An existing version-pinned Codex composer patch remains compatible with this control release.
