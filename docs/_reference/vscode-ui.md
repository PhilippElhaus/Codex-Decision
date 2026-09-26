# VS Code control

The companion extension in [`vscode-control/`](../../vscode-control/) provides a
status-bar item and a private bridge for a `jev` composer button. Clicking
either opens the three-integration selection list; clearing all disables Jev.
Gray means off, green means Jev API/key health passed,
red means Jev API health failed, and blue pulses for about 500 ms during a
decision or health probe. When `codexJev.mode` is
`observe`, both controls show `OBS`. The default setting is `replace`.

The composer button docks before the model selector, matches its measured height
and vertical center, contracts to its dot in a narrow panel, and hides before
it could overlap the selector. Its hover panel
shows mode, three indicators (outputs checked, replacements, average duration), and up to three
recent outcomes across tools. Small skipped results do not erase those
outcomes. Counters and outcomes start empty when a composer view opens and
reset on a new view URL, reload, or data-directory change. Toggling any
selection during a running Codex turn preserves the view's history. The hook
reads the saved selection when each tool finishes, so even a tool already
running can use the new setting at completion. A Jev request already underway
finishes under the setting it read; later tool results use the new setting.
The plugin's PostToolUse hook must already be registered in the Codex session;
installing the plugin or changing hook code still needs a fresh session.
Historical entries in
the shared log are never replayed into a new view. These are **view-scoped**
totals, not persisted per-conversation analytics.

Set `codexJev.dataDirectory` to the installed absolute `PLUGIN_DATA` directory
(a `\\wsl.localhost\<distro>\...` path on Windows), or set the
`CODEX_JEV_DATA_DIRECTORY` environment variable. A personal installation can
use `~/.codex/plugins/data/codex-jev-personal` in WSL. The public
extension package has no workstation-specific default. Mode changes are made
in VS Code's **Codex Jev Control: Mode** setting. The three checkboxes change
only their respective integration selections.

Codex offers no supported third-party composer control slot. The button uses
a **version-pinned local patch** for Codex VS Code extension `26.917.62051`.
[`patch_codex_webview.py`](../../vscode-control/patch_codex_webview.py) checks exact
host hashes and keeps rollback files under
`%LOCALAPPDATA%\Codex\codex-jev\rollback\26.917.62051`. A Codex
extension update may invalidate the patch; validate the new version before
reapplying. Reload each VS Code window where the button should appear. The
status bar remains available if the composer button cannot fit.

On Windows with a WSL Codex app server, the plugin detail page can fail with
`AbsolutePathBuf deserialized without a base path` if VS Code sends this
marketplace's Windows path to the WSL server. The version-pinned host bridge
maps the active user-level marketplace (or this repository's own marketplace
for a standalone installation) to its WSL absolute path for
`plugin/read`; it leaves other requests untouched. The Jev hook itself is
independent of this page. A missing cached hook file or hook process failure
returns the original tool result without replacement.
