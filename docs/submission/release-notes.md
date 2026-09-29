# Codex Jev 0.5.5 release notes

The active plugin remains one Rust hook. Three independent switches route output text, recognized test/build commands, and supported direct search/listing commands. The hook makes per-line Noul judgments in bounded batches. A disabled specialized route leaves its result unchanged, even when Output filter is enabled.

This update removes the retired `sample_chars` setting when a version 1 config is migrated or saved through VS Code control 0.4.5. Existing route selections, line policies, private logs, and keys are preserved. The plugin archive includes only nine required files; the Python hook from earlier releases is not included.

Install the plugin archive and companion VSIX together. Update the version-pinned Codex composer patch, then reload VS Code manually.
