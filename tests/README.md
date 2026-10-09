# Tests

The integrated VSIX must pass the native clean-install check before release:

```powershell
pwsh -NoProfile -File .\vscode-control\scripts\windows_integrated_smoke.ps1 `
  -Vsix .\.local\submission\codex-decision-0.11.7.vsix -Distro Ubuntu
```

This check uses the actual packaged extension, a copied supported Codex host,
an isolated Windows profile, and private Linux fixture state. It verifies fresh
installation, the exact hook cache, one registration, automatic UI repair,
restart idempotence, provider forwarding, session defaults, and native panel
rendering. It preserves the user's installed extensions, credentials, and chats.

Run the current release checks from the repository root. The offline tests use synthetic tool output and provider replies; they do not need an API key.

Use `cargo bench --locked -p codex-decision --bench pipeline -- all` for offline CPU and allocation measurements. Use `equivalence` instead of `all` to print fingerprints for 1,000 seeded complete packing cases. Give before and after builds different `CARGO_TARGET_DIR` paths. Compare fingerprints before interpreting timing results.

Run `node scripts/pipeline_stress.cjs --hook <verification-hook> --rounds 32 --concurrency 4` to exercise a shared session through real hook processes. The loopback mock uses synthetic credentials. The runner checks exact readable and typed originals, completed panels, counters, deliberate failures, and a managed-log bound. Use `--minutes 45` for a timed run or `--provider typesafe` for the second wire format. Use `--faults http,json,oversize,probability,model,timeout` to rotate protocol and deadline failures. Use `--jitter-ms 20` to vary response timing. Use `--allow-deadline` only for a constrained debug pressure test; it separately verifies full-result fallback and rollback at request or invocation deadlines. Unexpected mock errors still fail the run. Each group completes before the next begins. Millisecond latency buckets use bounded memory. Its disposable fixture stays off D: and removes only verified task files. See the [pipeline optimization report](../docs/development/pipeline_optimization_2026-10-07.md) for current evidence and limits.

```bash
CARGO_TARGET_DIR="$HOME/.cache/codex-decision/cargo-target" cargo test --locked -p codex-decision
CARGO_TARGET_DIR="$HOME/.cache/codex-decision/cargo-target" cargo clippy --locked --all-targets -- -D warnings
npm test --prefix vscode-control
python3 -m unittest discover -s tests -p 'test_*.py'
python3 vscode-control/scripts/browser_smoke.py
# Linux CI and Lab-Control (requires Playwright with Chromium):
python3 vscode-control/scripts/browser_smoke.py --browser chromium
```

Rust process tests launch the real hook against a local mock API. They cover routing, exact saved originals, incomplete and failed batches, Choice gate keep/filter/error paths, protected lines, malformed config, shared settings, private hook status, release versions, hook trust inspection, the pinned Codex webview patch, and two simultaneous session IDs with separate enabled flags and records. Node tests carry the pinned host bridge through the extension command to saved selections, cover synchronous command lookup failures and rejected commands, and cover the control bridge, shared settings without a thread, aggregated activity, one-time enabled defaults, preserved per-session choices, configuration and key validation, bounded log reads, panel validation, and connection errors. The browser smoke test renders the actual composer and settings scripts in Edge at four widths and checks internal thread changes without a URL change, plus healthy and failed API states, missing host replies, selection recovery, and home-screen settings. The panel harness renders the current version-6 cumulative relevance view, protected and pending rows, and historical version-3/4 snapshots. It checks result shrink and growth, changed source text and scores, animation restart, and clearing and restoring the panel. Python tests validate documentation links and default config values. The hardening regressions cover concurrent writes in separate processes, linked directory chains, oversized response streams, failed receipt publication, held log locks, physical-line limits, and focused-panel selection. [CI](../.github/workflows/verify.yml) runs the offline Rust, Node, and Python checks, builds and verifies both packages, and runs the real webview harnesses in Chromium. Edge remains a native Windows release check. Patch lifecycle tests use explicit fixture path conversion and run their assertions on Linux without WSL. Activity tests cover atomic log replacement, retained tails, and truncation. Settings tests drop replies, reject late replies, and throw from the transport to verify recovery.

To exercise the installed hook, run `decisionctl check-hook-trust --cwd <repository>` after installation and after every update. Then start a new Codex thread and run a local command with more than 256 characters of ordinary text while Decision is enabled. The control should be green after the API check; a completed decision appears in this session's logs. A key test checks the API only.

Use the reviewed output corpus below for live checks. The runner reads the installed key only in memory and sends synthetic output. Review receipts with `decisionctl evaluate-quality --cases <private JSON>` before changing cutoffs. Old ignored live Rust tests have been replaced by this runner; they assumed the retired request shape and copied a key file into a fixture.

Regenerate README screenshots with `python3 vscode-control/scripts/capture_docs.py`. The capture loads the real webviews through the visual and panel harnesses. It checks current relevance totals and the dated historical failing-test batch. The settings image shows the current 5% relevance cutoff. The fixtures contain no real keys or private conversations.

Migration checks cover all eight legacy switch combinations, conservative cutoff merging, invalid legacy fields, and saving only the current schema. Browser checks assert the single accessible switch, absence of the popup, and one shared relevance cutoff.

Run the reviewed dummy corpus against the debug hook:

```bash
# All five splits and one complete fault suite for each provider:
node scripts/dummy_matrix.cjs --hook <debug-hook> --jobs 2 --out .local/quality/dummy-matrix
# Individual splits or bounded live checks:
node scripts/two_stage_quality.cjs --out .local/two-stage/offline
node scripts/two_stage_quality.cjs --holdout --skip-faults --out .local/two-stage/offline-holdout
node scripts/two_stage_quality.cjs --batching --skip-faults --out .local/two-stage/offline-batching
node scripts/two_stage_quality.cjs --precision --skip-faults --out .local/two-stage/offline-precision
node scripts/two_stage_quality.cjs --precision-holdout --skip-faults --out .local/two-stage/offline-precision-holdout
node scripts/two_stage_quality.cjs --live --data-dir <installed-PLUGIN_DATA> --out .local/two-stage/live
node scripts/two_stage_quality.cjs --live --holdout --data-dir <installed-PLUGIN_DATA> --out .local/two-stage/live-holdout
```

Live runs use the installed key only in the proxy process memory. The hook uses a synthetic proxy key in an owned temporary directory. Only reviewed dummy output reaches the selected provider. A run stops at 120 HTTP calls or 500,000 returned usage tokens by default. Use `--case <id>` for one case and `--relevance-max <0..100>` for a cutoff trial. Reports separate proposed evidence loss from actual loss and check exact saved originals. The runner also saves a CLI quality audit that replays cutoffs with the real local protection rules. Fault runs assert that invalid answers publish no receipt, partial panel, or replacement. These tests prove application behavior for the fixtures, not universal model accuracy.

Batching fixtures cover 251–10,000 lines, long target text, Unicode, escaped JSON, ANSI/CRLF, and unpackable context. All emitted requests must fit both conservative API token bounds. The runner checks exactly-once coverage and complete target text. Later-batch fault cases verify rollback after an earlier valid relevance batch. The current panel accepts complete version-6 snapshots up to 10,000 source lines and 8 MiB. It includes earlier batches and protected lines; its row counts must match all recorded totals.

The runner requires a debug or verification hook and rejects the production binary before loading a live key. It reconciles proxy calls, persisted attempts, stage counts, receipts, errors, and completion counters. Eligible offline cases must produce their expected decision; local skips need an explicit expectation. Unexpected live errors stop further requests. Use `--case` with a fault ID for a focused failure rerun.

The base corpus includes all 34 protocol, timeout, and later-batch faults. Use
`--skip-faults` for additional corpus splits to avoid repeating that identical
fault suite. CI runs every reviewed output case and every fault scenario once.
Publication regressions also verify retries after failed original-pair or
receipt writes and rollback when hooks overlap in the same session.

The matrix runner starts at most two independent corpus processes by default.
Use `--jobs 1` for sequential measurements or up to `--jobs 4` on a larger host.
Each provider and split has its own log, receipts, and report. The destination
must be new so an earlier report cannot mask a failed process. Both providers
run the holdout, batching, and precision splits in CI; the identical fault cases
run once per provider in the base split. `summary.json` records the complete
matrix, case count, request count, evidence loss, failures, and wall time.

The interruption check kills the real debug hook after its first relevance
snapshot. It verifies that no completed receipt, replacement event, stats, or
saved original was published. A later invocation must complete with exact
readable and typed originals and a valid completed panel. It covers both
providers. CI also runs a short concurrent mixed-fault check for each provider.

```bash
node scripts/pipeline_interrupt.cjs --hook target/debug/decision-hook \
  --out .local/quality/pipeline-interrupt
node scripts/pipeline_stage_interrupt.cjs --hook target/verification/decision-hook \
  --require-recovered --out .local/quality/pipeline-staged-retry
node scripts/pipeline_stage_interrupt.cjs --hook target/verification/decision-hook \
  --concurrent-rollback --out .local/quality/pipeline-staged-rollback
node scripts/pipeline_commit_interrupt.cjs --hook target/verification/decision-hook \
  --out .local/quality/pipeline-publication
```

The staged checks verify identical retry and an overlapping original-file lease.
The publication check uses exact process-kill barriers for both providers before
and after stats, snapshot, event fsync, and the committed marker, including
rollback failure and deferred cleanup. Prepared writes must roll back; committed
writes must remain published. Readers must retain the prior committed view while
preparation is pending.

Precision cases cover late exhaustive requirements, extensionless and mixed
source reads, file-reading tools, heredocs, summary-plus-patch output, stale
task prevention, duplicate disabled settings, requested passing tests, exact
aggregates, and provenance. Holdout cases add semantic test names, multiple
requested tests and values, Unicode facts, timing, retry counts, and sequence
requirements. Credential sentinels require zero requests. Fault cases also
cover duplicate JSON fields and response bodies that trickle past the deadline.

Build the optimized synthetic hook with `cargo build --locked -p codex-decision --profile verification`. It retains assertions and the loopback endpoint while using optimized packing. Its binaries live under `target/verification/` (or your selected Cargo target directory). Use it for large concurrent pressure checks; an unoptimized debug build can reach the existing 45-second hook limit on a single CPU. Release packaging always builds a separate production profile with the test endpoint disabled.

The [processing recovery audit](../docs/development/processing_recovery_2026-10-08.md) records the skip recovery pass. The [request accounting and reliability audit](../docs/development/reliability_audit_2026-10-08.md) records the current counter boundaries, publication recovery, exact reader fixtures, and final acceptance results.

## Composer and panel quality checks

The offline quality runner validates each hook-produced panel snapshot with the real VS Code parser. It checks the receipt ID, completed status, request totals, and rollback after failed batches. Each successful case exports a normalized `panel.json` beside its synthetic receipt.

The browser quality runner varies toolbar gaps, model heights, permission labels, and pane widths in a 5,000-item synthetic chat. It verifies the toolbar row, button separation, and dot size. An optional hook-produced snapshot is rendered through the real panel script at the same widths. Repeat `--panel` to rotate multiple normalized snapshots. It checks completed bar animations every 100 rounds and records separate composer and panel heap samples plus panel DOM counts. Use `--resident-panels` for endurance with large snapshots: it loads fixtures once and clones a fresh message inside the page for each update. The default sends each complete snapshot through the debugger and includes that driver's overhead. Reports identify the transport; compare runs with the same transport. Use `--reload-every 500` to test repeated panel reloads. Use `--device-scale 2 --reduced-motion reduce` for display scaling and reduced motion checks. Timing reports and screenshots contain only synthetic data.

CI also rotates the historical reviewed panel and a current version-6 protected-row fixture through resident messages. It verifies every completed animation, reloads twice, and checks toolbar fallback. The large-snapshot endurance checks remain separate from this short regression check.

Use `--fallback-every 10` to remove and restore the toolbar neighbours every ten
rounds. This checks that an incomplete toolbar hides the indicator and that the
indicator returns when the controls become available.

```bash
python3 vscode-control/scripts/browser_quality.py --rounds 50 --seed 7 \
  --out .local/quality/browser
python3 vscode-control/scripts/browser_quality.py --minutes 110 --seed 17 \
  --reload-every 500 \
  --panel .local/two-stage/offline/log-failure-240/panel.json \
  --out .local/quality/browser-soak
```

In Lab-Control, keep executable test fixtures in an explicit user cache because
container data mounts can be `noexec`. Ordinary disposable data remains in `/tmp`.
The unsupported-host test preflights its fake executable before attempting the
submission script, so a broken fixture cannot start an unintended production build:

```bash
mkdir -p "$HOME/.cache/codex-decision/test-executables"
CODEX_DECISION_TEST_EXECUTABLE_TMP_ROOT="$HOME/.cache/codex-decision/test-executables" \
  python3 -m unittest discover -s tests -p 'test_*.py'
# Use the same executable root for the publication barrier shared library:
node scripts/pipeline_commit_interrupt.cjs --hook <verification-hook> \
  --barrier-build-root "$HOME/.cache/codex-decision/test-executables" \
  --out .local/quality/pipeline-publication
```

Node regressions cover restored threads without composer focus, persisted decisions after reload, readiness ordering, session changes during reads, stale failures, dropped or rejected deliveries, hidden or disposed views, configuration recovery, bounded snapshot reads after file growth, concurrent atomic snapshot replacement, and bounded Windows write retries. Linux checks exercise real file links and private inode permissions. Windows checks use directory junctions; file-link subtests report a skip when Developer Mode or elevation is unavailable.

The optional native Windows test uses the specified WSL distro, creates its own private `/tmp` fixture, and removes that exact fixture. It reads snapshots through WSL UNC paths while a Linux process replaces them. It also checks independent session selections and Linux file permissions. Enable it in a Windows terminal before running the Node suite:

```powershell
$env:CODEX_DECISION_TEST_WSL_DISTRO = 'Ubuntu'
npm test --prefix vscode-control
```

Run the [native VS Code panel smoke test](../vscode-control/scripts/windows_panel_smoke.ps1)
from Windows PowerShell 7:

```powershell
pwsh -NoProfile -File .\vscode-control\scripts\windows_panel_smoke.ps1 -Distro Ubuntu
```

This check starts an isolated VS Code instance with an empty extension directory
and synthetic WSL data. It instruments a disposable copy to acknowledge the
actual rendered rows. It checks CSP resource loading, saved decisions without
composer focus, three reloads, hiding and reopening, and session switching.
It removes its private profile and WSL fixture after the instance closes.
If the instance times out, the script reports its exact paths and preserves
the fixture until that owned process is stopped. The existing VS Code profile
and installed extensions are not changed.
