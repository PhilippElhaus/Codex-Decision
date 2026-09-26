# Codex Jev

<img src="assets/logo.png" width="64" alt="Codex Jev icon">

Codex Jev adds three independently selectable use cases. All start unselected.
The `PostToolUse` output filter asks Jev to check large repetitive tool results.
The **test/build log filter** identifies
routine pass and progress lines from recognized Bash commands, then asks Jev
whether those lines are safe to omit. In **replace** mode, each filter privately saves
the exact original before returning shorter model-visible text. **Observe**
mode records candidates and keeps the full result. Text-only MCP results are
evaluated by the output filter but need another opt-in to be replaced.
The **search/listing filter** uses one batched Jev request to classify groups
of broad `rg -n`, `rg --files`, or `git ls-files` results as retain, summarize,
or drop. Uncertain groups remain exact. All three use cases share one
`PostToolUse` hook, and each eligible result makes at most one Jev request.

## Install

```bash
codex plugin marketplace add /mnt/d/Codex-Jev
codex plugin add codex-jev@codex-jev
```

Use `D:\Codex-Jev` in place of `/mnt/d/Codex-Jev` from Windows PowerShell.
After a public GitHub repository exists, its repository URL can replace the
local path. This checkout does not require Codex Chime or the former combined
marketplace.

Existing `codex-jev@personal` installations can keep their ID and Jev data by
using the user-level `~/.agents/plugins/marketplace.json` to point at this
repository. On this workstation, that marketplace also lists Codex Chime; the
former combined repository is no longer needed for plugin discovery or updates.

Review and trust the bundled hook when prompted, then start a new Codex
thread. Upgrades from the former `codex-jev-output-pilot` ID require the
[migration steps](#upgrade-from-the-former-pilot-id) below to preserve the
selected hook, saved output, and credential setup.
Install the credential helper below before selecting a use case. CLI users can set
`enabled: true` for the output filter or `test_build_enabled: true` for test/build logs
or `search_listing_enabled: true` for broad search and file listings in `PLUGIN_DATA/config.json`.
The VS Code control offers three checkboxes and a
status indicator; see its
[setup and rollback guide](vscode-control/README.md).

## Interface preview

These screenshots use synthetic data and the real composer control script.
They contain no workspace output or credentials.

![Jev control beside the model selector](docs/images/jev-composer.png)

![Output and test/build selections in the control](docs/images/jev-menu.png)

![Hover panel with three activity indicators and recent outcomes](docs/images/jev-tooltip.png)

The [blue call state](docs/images/jev-pulse.png) fades in and out as shown in
the [pulse timeline](docs/images/jev-pulse-timeline.svg). The
[decision and credential flow](docs/images/jev-flow.svg) shows the data path.

## Credentials

Install the Windows request helper and protect the key with CurrentUser DPAPI.
For a portable setup, enter the key at the protected prompt:

```powershell
pwsh -File .\plugins\codex-jev\scripts\install_key_cache.ps1 -PromptForKey
```

To refresh automatically from an existing Vaultwarden helper, configure that
helper locally. It must support `materialize -CollectionName ... -Name ...
-OutputPath ...`:

```powershell
pwsh -File .\plugins\codex-jev\scripts\install_key_cache.ps1 `
  -VaultwardenHelper 'C:\path\to\vaultwarden-local.ps1' `
  -CollectionName '<collection>' -ItemName '<item>'
```

The encrypted key and request helper live under
`%LOCALAPPDATA%\Codex\codex-jev`; optional Vaultwarden source metadata
there contains no key. The WSL hook sends a bounded request to the Windows
helper over stdin. The key does not enter WSL environment variables, command
arguments, plugin data, or Jev logs. The control checks health when the output filter is enabled
and every five minutes. A configured Vaultwarden source can refresh a missing
or rejected key; prompt-based setup requires another prompt if the key changes.

## Decisions and data

| Gate or outcome | Behavior |
| --- | --- |
| All use cases unselected | No Jev request or log entry. |
| Broad search/listing command with the third filter selected | Validate the line format and task cue locally, batch Jev choices for at most 12 path groups, then keep exact relevant entries and compact only high-confidence lower-value groups. |
| Recognized test/build command with test/build filter selected | Locally identify known pass or progress lines, then ask Jev whether omitting them is safe. Replace only when Jev approves, a completion summary remains, and reduction exceeds 30% and 1,024 characters. Retain other lines and the exact original. |
| Test/build filter in observe mode | Ask Jev and record its judgment; Codex receives the full result. |
| Fewer than 8,192 or more than 2,000,000 characters | Skip locally. |
| Secret-looking input/output, diagnostics, structured or media MCP response, or low repetition | Keep full result; no Jev request. |
| Jev unavailable, invalid scores, or uncertain decision | Keep full result. |
| Strongly repetitive Bash output in replace mode | Save exact original, then return a head/tail excerpt and its path. |
| Eligible result in observe mode | Record a candidate; Codex receives full result. |
| Eligible text-only MCP output | Observe by default; set `allow_mcp_replacement: true` in `config.json` to opt in. |

The test/build filter recognizes direct commands such as
`python -m unittest`, `pytest`, `node --test`, `npm test`, `cargo build`, `go test`, and
`make build`. It rejects compound shell commands. It considers logs from
2,048 characters upward, requires at least eight routine lines and a
completion marker, and retains failures, warnings, diagnostics, and summaries.
It sends bounded samples of proposed omitted and retained text to Jev for
three judgments: routine noise, need for exact text, and one-off value. Jev
must approve before replacement; unavailable or uncertain judgments keep the
full log. The samples share the output filter's credential boundary.
Unrecognized and short logs remain unchanged. The hook routes recognized
test/build commands first, supported search/listing commands second, and other
results to the repetitive-output filter. Selection can change during an active
session; the next completed tool result reads the current config. A result is
sent to Jev at most once.

## Broad search and file listings

The third filter handles direct, line-oriented `rg -n`, `rg --files`, and
`git ls-files` Bash commands. It skips compound commands, structured output,
small lists, malformed rows, sensitive-looking text, and listings without a
recent user task from the session transcript. For searches, the command itself
can provide the task cue. The request contains only a short task cue and at
most 12 path-group descriptors, capped at 7,000 characters. The full Jev
request is capped at 10,000 characters; the full result
is not sent to Jev. One batched Choice request rates each group. A group is
dropped only at very high probability and confidence. Uncertain groups remain
verbatim, and summarized groups keep representative verbatim entries. The
replacement is capped at 8,000 characters and must save at least 30% and
1,024 characters. Otherwise Codex gets
the full result. The exact original is saved before any replacement and its
path appears in the shorter response. Observe mode evaluates without replacing.

This filter trims tool text before it enters context; it does not change
Codex's built-in compaction. The former `PreCompact` handoff is removed because
that hook cannot replace compaction input and did not directly save context.

Before a Jev request, the output filter filters locally and samples at most
12,000 characters by default. Jev answers three `Noul` judgments: routine
noise, need for exact text, and one-off value. The sensitive-content filter is
conservative and cannot prove arbitrary text is safe to send to an external
API; enable the hook only where this data boundary is acceptable. The Jev
request has a three-second deadline; the tool-output hook has a five-second
timeout. Search/listing requests can include up to 500 characters of the most
recent user task from the transcript; enable it only where sending that
excerpt to Jev is acceptable.

The exact original is stored at
`PLUGIN_DATA/outputs/<session-hash>/<call-hash>.txt` with owner-only permissions.
The replacement text names that path for recovery. `PLUGIN_DATA/events.jsonl`
stores decision metadata, filter name, scores, sizes, and elapsed time, not raw output. The
extension reads only this metadata. Do not publish the plugin data directory;
saved originals are retained until you remove them. The
[config example](config.example.json) lists all defaults: enablement, mode,
minimum and maximum size, sample size, timeout, model, and MCP opt-in. The
plugin rejects unknown or invalid config values.

The VS Code control estimates savings for each replacement from the original
and excerpt character counts. Its percentage describes shorter model-visible
tool text, not exact tokenizer counts or billed-token savings.

## VS Code control

The companion extension in [`vscode-control/`](vscode-control/) provides a
status-bar item and a private bridge for a `jev` composer button. Clicking
either opens the three-use-case selection list; clearing all disables Jev.
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
only their respective use-case selections.

Codex offers no supported third-party composer control slot. The button uses
a **version-pinned local patch** for Codex VS Code extension `26.917.62051`.
[`patch_codex_webview.py`](vscode-control/patch_codex_webview.py) checks exact
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

## Upgrade from the former pilot ID

The plugin folder and installed ID are now `codex-jev`. The former ID's data
and Windows credential directory do not move automatically. From this repo,
run these once before removing the old installation:

```bash
python3 scripts/migrate_legacy_data.py
pwsh.exe -NoProfile -NonInteractive -File scripts/migrate_legacy_key.ps1
codex plugin add codex-jev@personal
```

The data migration copies `config.json`, decision metadata, and saved originals
to `~/.codex/plugins/data/codex-jev-personal`. It verifies conflicts and leaves
the former data intact. The key migration uses the former local Vaultwarden
source metadata to install a fresh protected cache under
`%LOCALAPPDATA%\Codex\codex-jev`; it does not copy the encrypted key between
Windows accounts. If the former setup used a manual prompt, rerun
`install_key_cache.ps1 -PromptForKey` instead. Set `codexJev.dataDirectory`
to the new data path, reload VS Code, and start a new Codex thread. Remove the
former plugin and companion extension after the new installation works. Keep
the former saved outputs if old threads still refer to their paths.

Hosted tools such as web search do not pass through this hook. For nested
JavaScript tool calls, Codex returns the original result to the running script.
Replacement reduces model-visible text only when the raw result would
otherwise reach the model; a script that already summarizes output gains
little or no model token savings.

## Verification and measurement

Run from the repository root:

```bash
python3 -m unittest discover -s tests -v
python3 scripts/replay.py --per-category 100
python3 scripts/benchmark_context.py
python3 scripts/benchmark_all_filters.py --mode mock --per-variant 100
npm --prefix vscode-control test
python3 -m unittest discover -s vscode-control/tests -p 'test_*.py' -v
python3 vscode-control/scripts/browser_smoke.py
pwsh -File scripts/test_key_cache.ps1
python3 scripts/live_test_build_smoke.py
python3 scripts/live_search_listing_smoke.py
python3 scripts/live_three_filter_samples.py
python3 scripts/live_bridge_smoke.py
python3 scripts/measure_live.py --repetitions 5
python3 scripts/replay.py --live --bridge --per-category 3 --live-max-calls 30
python3 scripts/benchmark_all_filters.py --mode live --rounds 3
```

The [three-filter benchmark report](docs/benchmark-2026-09-26.md) includes
2,104 mocked policy cases and 30 live Jev calls over real command results.

The live test/build smoke runs real local test/build commands and makes Jev
requests through the protected credential bridge. The first seven commands
are offline from Jev's API.
The search/listing smoke runs a real repository search and a real `rg --files`
listing over a disposable corpus, then tests both with the live Jev bridge.
The three-filter sample script runs one real command per filter through the
selected hook, checks the exact saved originals, and reports model-visible
character reductions. It uses disposable plugin data by default. Pass the
installed `--hook-script` and the existing `--data-dir` to record three
clearly marked sample outcomes in the live Jev history; the originals will
remain in that plugin data directory.
The replay covers 1,000 deterministic
cases. Python tests cover policy gates, exact output recovery, failure paths,
configuration, process-level mocked Jev bridge calls for all three filters,
and large results above the two-million-character limit. Those large results
remain intact and make no Jev request. Near-limit fixtures check that the
Jev input stays bounded. Node tests cover log offsets, new-view resets, selection, health,
and statistics. The Edge browser harness exercises layout, tooltip, colors,
pill styling, dynamic model-selector height, pulse, and navigation at two widths. Patch tests exercise
apply/update/restore and tamper rejection. All `live_*` commands,
`measure_live.py`, and the live replay require a working Jev key and issue
real requests. `measure_live.py` uses synthetic logs and disposable
plugin data; it measures hook latency and model-visible output size. Both
benchmark scripts use exact `o200k_base` counts when `tiktoken` is installed,
otherwise they label their four-characters-per-token proxy. That encoding is
a context-size comparison, not verified Codex model billing. Neither script
measures a complete Codex task or model inference time.

A prior 90-case live Jev replay made 30 calls and selected 10 repetitive Bash
outputs with no false or missed replacements against synthetic labels. Those
labels do not establish accuracy on real tasks.

On 2026-09-26 the Jev-gated test/build smoke ran the actual plugin Python suite, a
failing Python unittest suite, a Node test suite, and a C build through the
`PostToolUse` adapter. Their respective model-visible text reductions were
95.2%, 82.7%, 93.5%, and 90.2% by character count after Jev approval. It
verified Jev request events and scores, failure details, summaries, exit code,
exact original recovery, and observe mode. This
is a controlled set of command outputs, not a full-task token or cost measurement.

On 2026-09-26 the search/listing smoke asked Jev about a real 18,673-character
repository search. Jev was uncertain, so the hook kept it intact. A separate
12,760-character `rg --files` listing was reduced to 4,183 visible characters
(67.2% smaller); the exact original remained recoverable. This is a
hook-level character comparison, not a measured full-task token saving.

A later installed-hook sample with all three filters selected wrote three
outcomes to the live Jev history. Each call returned a shorter model-visible
response and saved an exact, owner-only original:

| Filter and input | Original | Visible | Character reduction |
| --- | ---: | ---: | ---: |
| Repetitive output, 400 generated progress lines | 12,800 | 912 | 92.9% |
| Test/build, actual plugin Python suite | 7,945 | 309 | 96.1% |
| Search/listing, actual `rg --files` over a disposable corpus | 12,760 | 4,193 | 67.1% |

These are three controlled tool results, not full-task savings or billed token
measurements. The search smoke also kept a real repository search intact when
Jev was uncertain.

An oversized command-hook run checked all three filters with 2.08–2.46 million
characters per result. Each returned the original unchanged in 251–260 ms,
made no Jev request, and wrote no saved original. The maximum eligible result
is two million characters; the limit avoids paying for an oversized judgment.

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
run to run.

A second 2026-09-26 run used five live Jev calls per active mode and exact
`o200k_base` counts for the same synthetic build logs:

| Mode | Median hook wall time | Model-visible tokens across five runs |
| --- | ---: | ---: |
| Off | 213 ms | 16,290 |
| Observe | 1,381 ms | 16,290 |
| Replace | 1,385 ms | 1,316 |

All five eligible replace calls succeeded. The **91.9% token reduction** on
those outputs saved 14,974 tokenizer units while adding a median 1.17 seconds
of hook latency per call against off. A rough break-even would require the
downstream model to process at least 2,555 input tokens per second if no other
latency changed; that rate has not been measured here. Context relief can
still matter when time savings are zero. A separate live 27-case replay made
Jev calls only for eligible text; it selected all three repetitive Bash cases,
observed three text MCP cases, and kept 21 other results, with zero mismatches
against synthetic labels.

The 200-case mocked policy/context benchmark selected 20 repetitive outputs,
left 180 unchanged, and removed 61,990 of 545,170 `o200k_base` tokens (11.4%
across this deliberately mixed corpus). The selected outputs alone shrank
93.2%, saving a median 3,100 tokens per selected output, about 2.4% of a 128k
context window. These figures are context-size estimates, not measured Codex billing or
full-task savings. They apply only if raw tool text reaches the model; a nested
tool script that already summarizes the text gets little or no benefit.
