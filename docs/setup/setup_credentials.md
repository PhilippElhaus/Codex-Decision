# Configure provider keys

Codex Decision supports OpenAI Decisions with `gpt-6-luna` and TypeSafe Jev with `jev-latest`. Select the provider in **Connect Decision** or **Codex settings → Decision**. Keys stay local and never enter the webview when read from disk.

Store keys in the installed plugin’s private `PLUGIN_DATA/.env`, outside the repository:

```dotenv
OPENAI_API_KEY=your-openai-key
JEV_API_KEY=your-typesafe-key
```

Only the selected provider’s key is required. Save a key for each provider to switch without entering it again. Saving one key preserves the other. Settings show whether each provider has a saved key; saved values never return to the webview.

Automatic fallback is off by default. Enable **Use the other provider if needed** in Decision settings to permit eligible output to reach either configured provider. A missing primary key or a failed provider request can retry the complete evaluation once with the other provider. The retry uses that provider’s default model and the remaining hook deadline. Local safety checks and file errors do not trigger fallback. If both providers fail, the original output stays visible. Each completed receipt records the actual provider and whether fallback was used.

A default marketplace installation uses `~/.codex/plugins/data/codex-decision-codex-decision`. A personal marketplace installation uses `~/.codex/plugins/data/codex-decision-personal`. Use the directory reported by your installation. Set `codexDecision.dataDirectory` in VS Code to that absolute directory. For Windows VS Code with WSL, use a `\\wsl.localhost\<distro>\...` path. `CODEX_DECISION_DATA_DIRECTORY` is the equivalent environment setting.

On Linux, directories must use mode `700` and `.env` must use mode `600`. The parser treats the key as text and does not execute shell code. Use an editor or pipe a secret-manager value to the CLI. Do not put the value in arguments or chat:

```bash
decisionctl set-key --data-dir <PLUGIN_DATA>
decisionctl set-key --data-dir <PLUGIN_DATA> --provider typesafe
```

The first command writes `OPENAI_API_KEY`. The second writes `JEV_API_KEY`. Both require piped standard input. OpenAI requests go directly to `https://api.openai.com/v1/decisions`; TypeSafe requests go to `https://api.typesafe.ai/v1/systemone`. Only the matching key enters the HTTPS Authorization header.

In settings, choose the provider before testing or saving a key. Leave the key field empty to test that provider’s saved key. A provider change clears the draft field. Shared provider settings apply to all sessions; each session keeps its own enabled flag. Legacy configurations retain TypeSafe until you explicitly change providers.

For a standalone installation, set `"fallback_enabled": true` in schema-5 `config.json` or schema-4 shared `settings.json`. Shared settings take precedence. Keep this field false to use only the selected provider. Existing configurations default to false when the field is absent.

For this workstation, Vaultwarden is authoritative. The exact shared secure notes are `openai-decisions-api-key` and `typesafe-api-key` in organization `Elhaus`, collection `OpenClaw`. Use the supported Vaultwarden materialization helper for authorized operations. Keep temporary materializations private and remove them after use.

See [data handling](../architecture/design_data.md) for transmitted text and saved originals.
