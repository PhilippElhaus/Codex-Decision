# Context ranking

Decision ranks supplied source blocks or search results against a task. It returns every original block with a relevance score, confidence, and level probabilities. It does not fetch files, run commands, or discard low-ranked evidence.

Run **Decision: Register MCP Tools in Codex** after installing the VSIX. This command runs `codex mcp add` with the bundled native runtime and the selected runtime's data directory. The Codex CLI must be available in that runtime. Registration changes Codex's MCP configuration. Start a new Codex chat to load the tools. Windows and WSL use separate registrations and credentials.

The `rank_context` MCP tool accepts:

```json
{
  "query": "Find the failing assertion",
  "candidates": [
    {"id": "result-1", "text": "tests/example.rs:42: assertion failed"},
    {"id": "result-2", "text": "Build progress: compiling example"}
  ]
}
```

Supply 1–96 candidates with unique IDs. Each candidate contains only `id` and `text`. IDs are bounded to 128 bytes. Text is bounded to 24,000 bytes per candidate, and the complete request must fit the provider budgets. Oversized inputs are rejected rather than truncated.

Scores range from 0 to 3: unrelated, background, directly useful, and essential. Equal scores retain source order. Confidence describes the returned distribution; it does not establish correctness. The result includes every exact original and its `original_index`.

**Decision: Rank Context** accepts the same object as a command argument. With no argument, it uses the selected editor text as one candidate and asks for the task. Results open in an untitled JSON document.

Optional `cache_reference` supplies stable shared reference text, up to 16,384 bytes. OpenAI requests mark its boundary explicitly. Other shared evidence follows that boundary. Without this field, OpenAI uses automatic prompt caching. A hit still requires a sufficiently long, identical prefix; Decision does not pad evidence. TypeSafe receives the reference as structured state. See [provider contracts](../architecture/providers.md).

The MCP server can also run directly:

VS Code commands resolve the verified installed hook before execution. WSL uses its executable plugin cache; it does not execute an unpacked Linux payload whose Windows archive permissions may lack an execute bit. Re-run registration after a Decision update to refresh the version-specific MCP executable path.

```bash
PLUGIN_DATA=/absolute/plugin-data /absolute/decision-hook --mcp
```

It uses newline-delimited JSON-RPC on standard input and output. Diagnostics stay on standard error. Provider failures return a tool error. Explicit MCP use does not enable filtering in a disabled thread.
