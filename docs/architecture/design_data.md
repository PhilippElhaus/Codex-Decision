# Data handling

Local checks run before Jev receives text. For an ordinary output, the output filter sends at most 12,000 sample characters by default. For a larger eligible output, it covers the entire text in chunks of at most 20,000 serialized JSON bytes and combines the answers conservatively: every chunk must be approved. It makes at most 128 chunk requests; beyond that limit, it keeps the full output without calling Jev. Test/build sends bounded samples of lines it may omit and retain. Search/listing sends a task cue and up to 12 path groups. That request is capped at 10,000 characters; it does not contain the full search result. A task cue can include up to 500 characters from the latest user request.

The full serialized Jev request is capped at 28,000 UTF-8 bytes, below Jev's 32k-token state plus longest-question limit. Oversized requests keep the original. The checks cannot prove that text is safe to send to an external API. Select an integration only if its text can go to Jev. Each Jev request has a three-second deadline by default. The hook has a 60-second timeout to allow bounded parallel chunk checks.

For eligible requests, the hook reads `JEV_API_KEY` from private `PLUGIN_DATA/.env` and sends it in an HTTPS Authorization header. The key does not enter tool text or decision logs. See [key setup](../setup/setup_credentials.md).

Before replacement, the hook saves the exact result at `PLUGIN_DATA/outputs/<session-hash>/<call-hash>.txt` with owner-only permissions. The shorter text gives Codex that path. `PLUGIN_DATA/events.jsonl` stores decision metadata, not raw output. Saved originals stay until you remove them. Keep the plugin data directory private.

Hosted web search does not pass through this hook. A nested JavaScript tool call gives the original result to its script. Jev saves model-visible tokens only when the raw tool text would reach Codex. The VS Code control estimates reduction from character counts; it does not report billed tokens.
