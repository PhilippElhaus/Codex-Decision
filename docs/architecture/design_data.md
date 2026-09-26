# Data handling

Codex Jev sends bounded text to Jev only after local gates accept a tool result. The output filter samples at most 12,000 characters by default. The test/build integration sends bounded samples of proposed omitted and retained lines. Search/listing sends a short task cue and up to 12 path-group descriptors, capped at 7,000 characters. Its full Jev request is capped at 10,000 characters; it does not send the full search result. A task cue can include up to 500 characters of the latest user request from the transcript.

The sensitive-content filter is conservative. It cannot prove that arbitrary text is safe for an external API. Enable an integration only when sending its bounded sample to Jev is acceptable. The Jev request has a three-second deadline; the tool-output hook has a five-second timeout.

The hook reads the API key from private `PLUGIN_DATA/.env` only for an eligible request. It sends the key in the HTTPS Authorization header. It does not write the key to a decision log or returned tool text. See [credential setup](../setup/setup_credentials.md).

Before replacement, the hook saves the exact original at `PLUGIN_DATA/outputs/<session-hash>/<call-hash>.txt` with owner-only permissions. The shorter response gives Codex that recovery path. `PLUGIN_DATA/events.jsonl` stores metadata such as integration, decision, scores, sizes, and elapsed time. It does not store raw output. Do not publish the plugin data directory; saved originals remain until you remove them.

The VS Code control reads decision metadata. It estimates the visible reduction from character counts. That percentage is not an exact tokenizer count or billed-token saving.

Hosted tools such as web search do not pass through this hook. For nested JavaScript tool calls, Codex returns the original result to the running script. Replacement reduces model-visible text only when the raw result would otherwise reach the model. A script that already summarizes output gains little or no model token saving.
