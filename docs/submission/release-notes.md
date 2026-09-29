# Codex Jev 0.5.4 release notes

The three integration switches now control separate input routes. A recognized test/build command uses only **Test/build logs**; a supported direct search or file-listing command uses only **Search/listing**. Turning either switch off leaves that result unchanged even when **Output filter** is on. Output filter continues to handle other eligible tool text. Unsupported search/listing commands and compound shell commands remain untouched.

The Rust hook classifies the command before checking which integrations are enabled. Skipped results make no Jev request and do not add a decision, receipt, or statistics count. Per-line Noul judgments, local evidence protections, and the saved-original behavior are unchanged.

VS Code control 0.4.4 clarifies each switch's scope in the composer menu and settings page. Documentation screenshots show the updated controls. Install the plugin archive and VSIX together, update the version-pinned Codex composer patch, then reload VS Code manually. Existing settings and private logs are preserved.
