# Initial submission release notes

Codex Jev adds optional local `PostToolUse` filters for repetitive tool output, routine test/build logs, and broad search or file listings. Eligible text is checked through TypeSafe AI's Jev API. Uncertain results remain intact, and a shortened result includes a path to its exact local original. The bundled `jev-output` skill guides setup and evidence review.

This is the initial public-directory submission of version `0.3.0`. All filters start disabled. Users need their own TypeSafe API key and must trust the local hook. The VS Code control and version-pinned composer patch are optional and installed separately. Hosted web environments without the hook scripts do not run the filters. The package contains no MCP server, demo credentials, or custom MCP UI.
