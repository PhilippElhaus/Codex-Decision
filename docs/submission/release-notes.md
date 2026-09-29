# Codex Jev 0.5.3 release notes

This release remaps the Jev panel's line bars to a visual retention index. Gold kept lines sit near one; blue cut lines sit near zero. The index combines the final action with the underlying omission, exact-text, and optional task-relevance Noul values. It is explicitly labeled as a display index, while the original probabilities remain available on hover. The Rust filtering policy, private receipts, and version 3 snapshot format are unchanged.

VS Code control 0.4.3 spreads large batches into columns and shows the number kept out of all source lines. The full-block bars visibly grow in parallel over 900 ms even when Windows reports reduced motion; values fade in afterward and the batch rests for another second. The dark and light screenshots show 50 synthetic lines reduced to 3 kept.

Install the plugin archive and VSIX together, then reload VS Code manually. An existing version-pinned Codex composer patch remains compatible with this control release.
