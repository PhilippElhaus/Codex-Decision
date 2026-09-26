# Codex Jev

<img src="assets/logo.png" width="64" alt="Codex Jev icon">

Codex Jev adds one synchronous `PostToolUse` hook to Codex. Its hook starts
unselected. Once selected, **replace** is the default mode: Jev checks large,
repetitive tool results, and approved Bash output becomes a short excerpt with
a path to the privately saved original. **Observe** mode records decisions and
keeps the full result. Text-only MCP results are evaluated but need another
opt-in to be replaced.

## Install

```bash
codex plugin marketplace add Elhaus-Labs/Codex --ref main
codex plugin add codex-jev-output-pilot@personal
```

Review and trust the bundled hook when prompted, then start a new Codex
thread. The installed ID remains `codex-jev-output-pilot` so existing config
and saved outputs continue to work under the new **Codex Jev** display name.
Install the credential helper below before selecting the hook. CLI users can
select it by setting `enabled: true` in `PLUGIN_DATA/config.json`. The VS Code
control offers a checkbox and status indicator; see its
[setup and rollback guide](vscode-control/README.md).

## Interface preview

These screenshots use synthetic data and the real composer control script.
They contain no workspace output or credentials.

![Jev control beside the model selector](docs/images/jev-composer.png)

![Hover panel with call totals and three recent outcomes](docs/images/jev-tooltip.png)

The [blue call state](docs/images/jev-pulse.png) fades in and out as shown in
the [pulse timeline](docs/images/jev-pulse-timeline.svg). The
[decision and credential flow](docs/images/jev-flow.svg) shows the data path.

## Credentials

Install the Windows request helper and protect the key with CurrentUser DPAPI.
For a portable setup, enter the key at the protected prompt:

```powershell
pwsh -File .\plugins\codex-jev-output-pilot\scripts\install_key_cache.ps1 -PromptForKey
```

To refresh automatically from an existing Vaultwarden helper, configure that
helper locally. It must support `materialize -CollectionName ... -Name ...
-OutputPath ...`:

```powershell
pwsh -File .\plugins\codex-jev-output-pilot\scripts\install_key_cache.ps1 `
  -VaultwardenHelper 'C:\path\to\vaultwarden-local.ps1' `
  -CollectionName '<collection>' -ItemName '<item>'
```

The encrypted key and request helper live under
`%LOCALAPPDATA%\Codex\jev-output-pilot`; optional Vaultwarden source metadata
there contains no key. The WSL hook sends a bounded request to the Windows
helper over stdin. The key does not enter WSL environment variables, command
arguments, plugin data, or Jev logs. The control checks health when enabled
and every five minutes. A configured Vaultwarden source can refresh a missing
or rejected key; prompt-based setup requires another prompt if the key changes.

## Decisions and data

| Gate or outcome | Behavior |
| --- | --- |
| Hook unselected | No Jev request or log entry. |
| Fewer than 8,192 or more than 2,000,000 characters | Skip locally. |
| Secret-looking input/output, diagnostics, structured or media MCP response, or low repetition | Keep full result; no Jev request. |
| Jev unavailable, invalid scores, or uncertain decision | Keep full result. |
| Strongly repetitive Bash output in replace mode | Save exact original, then return a head/tail excerpt and its path. |
| Eligible result in observe mode | Record a candidate; Codex receives full result. |
| Eligible text-only MCP output | Observe by default; set `allow_mcp_replacement: true` in `config.json` to opt in. |

Before a Jev request, the hook filters output locally and samples at most
12,000 characters by default. Jev answers three `Noul` judgments: routine
noise, need for exact text, and one-off value. The sensitive-content filter is
conservative and cannot prove arbitrary text is safe to send to an external
API; enable the hook only where this data boundary is acceptable. The Jev
request has a three-second deadline; the hook has a five-second timeout.

The exact original is stored at
`PLUGIN_DATA/outputs/<session-hash>/<call-hash>.txt` with owner-only permissions.
The replacement excerpt names that path for recovery. `PLUGIN_DATA/events.jsonl`
stores decision metadata, scores, sizes, and elapsed time, not raw output. The
extension reads only this metadata. Do not publish the plugin data directory;
saved originals are retained until you remove them. The
[config example](config.example.json) lists all defaults: enablement, mode,
minimum and maximum size, sample size, timeout, model, and MCP opt-in. The
plugin rejects unknown or invalid config values.

## VS Code control

The companion extension in [`vscode-control/`](vscode-control/) provides a
status-bar item and a private bridge for a `jev` composer button. Clicking
either opens a one-hook selection list; clearing it disables Jev. Gray means
off, green means API/key health passed, red means health failed, and blue pulses
for about 500 ms during a Jev call or health probe. When `jevPilot.mode` is
`observe`, both controls show `OBS`. The default setting is `replace`.

The composer button docks before the model selector, contracts to its dot in a
narrow panel, and hides before it could overlap the selector. Its hover panel
shows mode, call totals, average duration, characters checked, and up to three
recent outcomes across tools. Small skipped results do not erase those
outcomes. Counters and outcomes start empty when a composer view opens and
reset on a new view URL, reload, or hook deactivation. Historical entries in
the shared log are never replayed into a new view. These are **view-scoped**
totals, not persisted per-conversation analytics.

Set `jevPilot.dataDirectory` to the installed absolute `PLUGIN_DATA` directory
(a `\\wsl.localhost\<distro>\...` path on Windows), or set the
`CODEX_JEV_DATA_DIRECTORY` environment variable. A personal installation can
use `~/.codex/plugins/data/codex-jev-output-pilot-personal` in WSL. The public
extension package has no workstation-specific default. Mode changes are made
in VS Code's **Codex Jev Control: Mode** setting. The hook checkbox changes
only enablement.

Codex offers no supported third-party composer control slot. The button uses
a **version-pinned local patch** for Codex VS Code extension `26.917.62051`.
[`patch_codex_webview.py`](vscode-control/patch_codex_webview.py) checks exact
host hashes and keeps rollback files under
`%LOCALAPPDATA%\Codex\jev-output-pilot\rollback\26.917.62051`. A Codex
extension update may invalidate the patch; validate the new version before
reapplying. Reload each VS Code window where the button should appear. The
status bar remains available if the composer button cannot fit.

Hosted tools such as web search do not pass through this hook. For nested
JavaScript tool calls, Codex returns the original result to the running script.
Replacement reduces model-visible text only when the raw result would
otherwise reach the model; a script that already summarizes output gains
little or no model token savings.

## Verification and measurement

Run from the repository root:

```bash
python3 -m unittest discover -s plugins/codex-jev-output-pilot/tests -v
python3 plugins/codex-jev-output-pilot/scripts/replay.py --per-category 100
npm --prefix plugins/codex-jev-output-pilot/vscode-control test
python3 -m unittest discover -s plugins/codex-jev-output-pilot/vscode-control/tests -p 'test_*.py' -v
python3 plugins/codex-jev-output-pilot/vscode-control/scripts/browser_smoke.py
pwsh -File plugins/codex-jev-output-pilot/scripts/test_key_cache.ps1
python3 plugins/codex-jev-output-pilot/scripts/live_bridge_smoke.py
python3 plugins/codex-jev-output-pilot/scripts/measure_live.py --repetitions 3
```

The first six commands are offline. The replay covers 1,000 deterministic
cases. Python tests cover policy gates, exact output recovery, failure paths,
and config; Node tests cover log offsets, new-view resets, selection, health,
and statistics. The Edge browser harness exercises layout, tooltip, colors,
pulse, and navigation at two widths. Patch tests exercise apply/update/restore
and tamper rejection. The last two Python commands require a working Jev key
and issue real requests. `measure_live.py` uses synthetic logs and disposable
plugin data; it measures hook latency and character reduction, not model token
or end-to-end task savings.

A prior 90-case live Jev replay made 30 calls and selected 10 repetitive Bash
outputs with no false or missed replacements against synthetic labels. Those
labels do not establish accuracy on real tasks.

On 2026-09-26, three live Jev calls per active mode against synthetic
11.5k-character Bash logs gave these hook-level results through the actual
Windows credential bridge:

| Mode | Median hook wall time | Model-visible tool text across three runs |
| --- | ---: | ---: |
| Off | 445 ms | 34,656 characters |
| Observe | 1,562 ms | 34,656 characters |
| Replace | 1,614 ms | 2,697 characters |

All three replace calls selected replacement, a 92.2% character reduction.
The wall times include Python process startup and bridge work, and varied from
run to run. These measurements do not establish token or full-task savings;
those depend on whether the raw output would otherwise reach the model and
whether a later step needs the saved original.
