# Configuration

Completion verification has a separate private `assistance.json` file with version 1 and `completion_verification` set to `off`, `observe`, or `enforce`. It starts off. Use **Decision: Configure Completion Verification**. See [completion verification](completion-verification.md). Explicit assistance commands and MCP use the selected provider connection independently of the filtering enabled flag.

The session configuration uses schema 5. Shared settings use schema 4. [config.example.json](../../config.example.json) and [config-contract.json](../../vscode-control/config-contract.json) define the shipped defaults. Validation lives in the Rust hook and [control schema](../../vscode-control/schema.js).

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `false` in the standalone example | Enable the selected scope |
| `mode` | `replace` | `replace` is Filter; `observe` is Monitor |
| `provider` | `openai` | `openai`, `typesafe`, or `custom` |
| `model` | `gpt-6-luna` | Model for the selected provider |
| `fallback_enabled` | `false` | Permit one complete retry with the other built-in provider |
| `min_chars` | `256` | Minimum output size in UTF-8 bytes |
| `max_chars` | `2000000` | Maximum output size in UTF-8 bytes |
| `timeout_seconds` | `3.0` | Request timeout, bounded by the hook deadline |
| `allow_mcp_replacement` | `false` | Permit eligible generic MCP replacement after local checks |
| `log_limit_mb` | `50` | Managed per-session log retention budget |
| `never_delete_logs` | `false` | Preserve history; bounded telemetry stops when full |
| `relevance_policy.relevant_max` | `5` | Inclusive omission cutoff, as a percentage |

The `min_chars` and `max_chars` names are historical identifiers. Their units are bytes. Receipt character counts use Unicode scalar values.

The integrated control creates an enabled configuration once for a new local thread. It then preserves that thread's choice. This differs from the disabled standalone example. Records live under `PLUGIN_DATA/sessions/<session-hash>/`. Provider settings, mode, relevance cutoff, and retention are installation-wide in `PLUGIN_DATA/settings.json`. Shared behavior fields override corresponding session fields. They do not replace the session's enabled choice.

For standalone use, `"scope": "global"` in `PLUGIN_DATA/config.json` enables an installation-wide configuration. A session configuration overrides that choice. Use the settings form when available.

`codexDecision.dataDirectory` is an optional absolute override. `CODEX_DECISION_DATA_DIRECTORY` supplies the environment equivalent. Automatic discovery follows the selected native or WSL runtime. A mismatched explicit override is preserved and reported. Clear the override and run **Decision: Repair Integration** to return to automatic discovery.

Stored records remain readable where the application implements migration. New writes use the current schemas. Do not copy retired switches or old provider defaults into new configuration.

Custom endpoint, authentication identity, response model, and public CA trust belong in the `custom_provider` shared-settings object. Manage secrets through the connection form or supported CLI. See [provider setup](../setup/providers.md).
