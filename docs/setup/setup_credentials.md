# Configure the Jev API key

Codex Jev reads `JEV_API_KEY` from `PLUGIN_DATA/.env`. This plaintext file belongs in the installed plugin's user-local data directory, outside the Git repository. Keep it private. On Linux, the hook requires owner-only file permissions. A missing or invalid key leaves the original tool output visible.

For a default `codex-jev@codex-jev` installation, the data directory is `~/.codex/plugins/data/codex-jev-codex-jev`. Create `.env` there with a text editor. Its only required line is:

```dotenv
JEV_API_KEY=your-key
```

On Linux or WSL, make the directory private and set the file mode to `600`. From a checkout, the included prompt does this for you without placing the key in shell history:

```bash
python3 scripts/configure_key.py --data-dir "$HOME/.codex/plugins/data/codex-jev-codex-jev"
```

The parser treats the value as text. It does not execute shell code. The hook sends bounded requests directly to `https://api.typesafe.ai/v1/systemone` with the key in the HTTPS Authorization header. The key does not enter command arguments, tool output, decision logs, or the VS Code webview. The extension reads the same file only to check Jev health when an integration is enabled.

Set `codexJev.dataDirectory` in VS Code to the same absolute directory. For a WSL installation used by Windows VS Code, use a `\\wsl.localhost\<distro>\...` path. `CODEX_JEV_DATA_DIRECTORY` is an alternative setting for the control and the live benchmark scripts.

In **Codex settings → Jev settings**, you can enter or change the key and test it before saving. The page never displays a saved key; leave the field blank to keep it. Changes to hook cutoffs also live there.

See [data handling](../architecture/design_data.md) for the text sent to Jev and the saved originals.
