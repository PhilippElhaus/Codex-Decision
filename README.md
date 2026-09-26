# Jev Output Pilot

An installed, opt-in Codex plugin with one synchronous `PostToolUse` hook. Its
default config is `enabled: false`, `mode: "observe"`. The hook considers only
large, repetitive Bash output and text-only MCP output. Observe mode records a
metadata-only decision without changing the result Codex sees. Replacement
requires a separate `mode: "replace"` config change; it saves the exact Bash
output privately before returning an excerpt and recovery path. MCP replacement
has its own additional opt-in.

The hook skips small, oversized, sensitive-looking, diagnostic, structured, and
non-repetitive results locally. A qualifying result sends at most a bounded
sample to Jev for three `Noul` judgments. API errors, uncertain scores, and
storage failures retain the original result. The sensitive-content filter is
conservative and cannot prove arbitrary output is safe to send to an external
API; select the hook only for workspaces where this data boundary is acceptable.

## Credential path

`scripts/install_key_cache.ps1` fetches the exact
`OpenClaw/typesafe-api-key` Vaultwarden item on Windows, encrypts it with
CurrentUser DPAPI, and stores it at
`%LOCALAPPDATA%\Codex\jev-output-pilot\key.dpapi`. It installs
`invoke_jev.ps1` and `refresh_key_cache.ps1` beside the cache. Plaintext is
materialized only in a private OS temporary directory during refresh and then
removed. The WSL hook sends a bounded request to the Windows helper over stdin;
the key is not placed in WSL environment variables, command arguments, plugin
data, or Jev logs. A selected control checks the API at startup and every five
minutes, refreshing the cached key from Vaultwarden on missing or rejected
credentials. Refresh can take about 30 seconds; normal Jev requests use the
encrypted cache and normally take much less time.

Run a manual refresh with PowerShell 7:

```powershell
& "$env:LOCALAPPDATA\Codex\jev-output-pilot\refresh_key_cache.ps1"
```

## UI and configuration

The companion VS Code extension in [`vscode-control/`](vscode-control/) adds a
status-bar control and a private message bridge for a `jev` text button in the
Codex composer. Clicking the composer button opens a one-hook checkbox list;
clearing it disables Jev. The button is gray when off, green after a successful
API/key check, red on failure, and blue for about 500 ms while Jev is called.
It docks before the model selector, reduces to a dot as that gap narrows, and
hides before it would overlap the selector. Hovering shows the latest
metadata-only decision. The hook selection is stored
in the Codex plugin's official `PLUGIN_DATA/config.json` directory, which is
outside this repository. The installed instance on this workstation uses
`~/.codex/plugins/data/codex-jev-output-pilot-personal/config.json` in WSL.

Codex has no supported third-party composer control slot. The composer button
is a **version-pinned local patch** for OpenAI Codex VS Code extension
`26.917.62051`. [`vscode-control/patch_codex_webview.py`](vscode-control/patch_codex_webview.py)
checks exact original hashes, backs up the host files under
`%LOCALAPPDATA%\Codex\jev-output-pilot\rollback\26.917.62051`, installs the
bridge and control, and can restore only when the patched files still match its
recorded hashes. A Codex extension update may remove or invalidate the patch;
re-run validation against that version before repatching. Reload each VS Code
window where the button should appear. The status-bar control remains a fallback.

The hook timeout is five seconds; the Jev request has a three-second API
deadline. Hosted tools such as web search do not pass through this hook.

## Verification

```bash
python3 -m unittest discover -s plugins/codex-jev-output-pilot/tests -v
python3 plugins/codex-jev-output-pilot/scripts/replay.py --per-category 100
npm --prefix plugins/codex-jev-output-pilot/vscode-control test
python3 plugins/codex-jev-output-pilot/vscode-control/scripts/browser_smoke.py
python3 plugins/codex-jev-output-pilot/scripts/live_bridge_smoke.py
```

The replay covers 1,000 deterministic cases. A prior 90-case live Jev replay
made 30 calls and selected 10 repetitive Bash outputs with no false or missed
replacements against synthetic labels. These labels do not establish accuracy
or net speed on real tasks. Measure representative tasks in off, observe, and
replace modes before judging the actual benefit.
