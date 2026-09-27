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

The parser treats the value as text. It does not execute shell code. The hook sends bounded requests directly to `https://api.typesafe.ai/v1/systemone` with the key in the HTTPS Authorization header. The key does not enter command arguments, tool output, or decision logs. If you use the Codex side window setup, the entered key passes through its local webview bridge to the extension. The extension checks for a saved key and probes Jev health when an integration is enabled.

Set `codexJev.dataDirectory` in VS Code to the same absolute directory. For a WSL installation used by Windows VS Code, use a `\\wsl.localhost\<distro>\...` path. `CODEX_JEV_DATA_DIRECTORY` is an alternative setting for the control and the live benchmark scripts.

Enabling an integration without a key opens **Connect Jev** over the Codex side window. Enter a typesafe.ai API key there, test it, then save it. A link below Save and Skip opens the typesafe.ai homepage in the system browser. **Skip for now** closes the prompt without saving; **Connect Jev…** in the Jev menu and **Connect** in the missing-key tooltip reopen it. In **Codex settings → Jev**, below **Voice**, a saved key is indicated by a masked placeholder; its value never reaches the webview. Click **Test API key** with the field empty to test the saved key; enter a different key to test or save a replacement. The result appears beside the button. Changes to hook cutoffs also live there.

See [data handling](../architecture/design_data.md) for the text sent to Jev and the saved originals.
