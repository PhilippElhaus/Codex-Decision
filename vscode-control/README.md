# Jev control for VS Code

The installed companion extension shows a `jev` status-bar indicator and
handles the composer button's private message bridge. The composer button opens
the single `PostToolUse` hook checkbox. An empty selection turns the hook off.
Hovering shows the selected mode and latest metadata-only decision.
The composer control docks immediately before the model selector, reduces to
its colored dot when the available gap narrows, and hides if even the dot
cannot fit without covering the selector. The hook remains selectable from
the VS Code status bar in that case.

| Color | Meaning |
| --- | --- |
| Gray | No hook selected |
| Green | Jev API and cached Vaultwarden key work |
| Blue, about 500 ms | Jev request or health probe in progress |
| Red | API/key health failed |

`jevPilot.dataDirectory` points to the installed plugin's `PLUGIN_DATA` folder
through `\\wsl.localhost\Ubuntu`. Its packaged default is specific to this
workstation. `jevPilot.credentialDirectory` defaults to the Windows user-local
DPAPI cache. The key never enters the extension process or webview. The health
check runs after selection and every five minutes. A missing or rejected key
triggers a Vaultwarden refresh before retrying; a normal check takes about two
seconds, while refresh may take about 30 seconds.

The in-composer button uses a reversible, version-pinned patch to the installed
Codex extension. Run `patch_codex_webview.py --help` for apply, update, and
restore syntax. `update` verifies the installed host files and replaces only
the Jev UI asset, retaining the original rollback files.
Its rollback files stay outside the repository under `%LOCALAPPDATA%`. Reload
the VS Code window after installing or restoring the patch.

Run `npm test` for unit/integration tests and `python3 scripts/browser_smoke.py`
for the headless browser test of button placement, selection, tooltip, colors,
and the VS Code message contract. [`composer-preview.html`](composer-preview.html)
is a standalone visual mock for design review.
