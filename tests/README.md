# Tests

Run the current release checks from the repository root. The offline tests use synthetic tool output and Jev replies; they do not need an API key.

```bash
CARGO_TARGET_DIR="$HOME/.cache/codex-jev/cargo-target" cargo test --locked -p codex-jev
CARGO_TARGET_DIR="$HOME/.cache/codex-jev/cargo-target" cargo clippy --locked --all-targets -- -D warnings
npm test --prefix vscode-control
python3 -m unittest discover -s tests -p 'test_*.py'
python3 vscode-control/scripts/browser_smoke.py
# Linux CI and Lab-Control (requires Playwright with Chromium):
python3 vscode-control/scripts/browser_smoke.py --browser chromium
```

Rust process tests launch the real hook against a local mock API. They cover routing, exact saved originals, incomplete and failed batches, Choice gate keep/filter/error paths, protected lines, malformed config, shared settings, private hook status, release versions, hook trust inspection, the pinned Codex webview patch, and two simultaneous session IDs with separate enabled flags and records. Node tests carry the pinned host bridge through the extension command to saved selections, cover synchronous command lookup failures and rejected commands, and cover the control bridge, shared settings without a thread, aggregated activity, one-time enabled defaults, preserved per-session choices, configuration and key validation, bounded log reads, panel validation, and connection errors. The browser smoke test renders the actual composer and settings scripts in Edge at four widths and checks internal thread changes without a URL change, plus healthy and failed API states, missing host replies, selection recovery, and home-screen settings. The panel harness renders the current version-4 relevance view and historical version-3 snapshots. Python tests validate documentation links and default config values. The hardening regressions cover concurrent writes in separate processes, linked directory chains, oversized response streams, failed receipt publication, held log locks, physical-line limits, and focused-panel selection. [CI](../.github/workflows/verify.yml) runs the offline Rust, Node, and Python checks, builds and verifies both packages, and runs the real webview harnesses in Chromium. Edge remains a native Windows release check. Patch lifecycle tests use explicit fixture path conversion and run their assertions on Linux without WSL. Activity tests cover atomic log replacement, retained tails, and truncation. Settings tests drop replies, reject late replies, and throw from the transport to verify recovery.

To exercise the installed hook, run `jevctl check-hook-trust --cwd <repository>` after installation and after every update. Then start a new Codex thread and run a local command with more than 256 characters of ordinary text while Jev is enabled. The control should be green after the API check; a completed decision appears in this session's logs. A key test checks the API only.

Use the current two-stage corpus below for live checks. The runner reads the installed key only in memory and sends synthetic output. Review receipts with `jevctl evaluate-quality --cases <private JSON>` before changing cutoffs. Old ignored live Rust tests have been replaced by this runner; they assumed the retired request shape and copied a key file into a fixture.

Regenerate README screenshots with `python3 vscode-control/scripts/capture_docs.py`. The capture loads the real webviews through the visual and panel harnesses. It checks current relevance totals and the dated historical failing-test batch. The settings image shows the current 5% relevance cutoff. The fixtures contain no real keys or private conversations.

Migration checks cover all eight legacy switch combinations, conservative cutoff merging, invalid legacy fields, and saving only the current schema. Browser checks assert the single accessible switch, absence of the popup, and one shared relevance cutoff.

Run the two-stage dummy corpus against the debug hook:

```bash
node scripts/two_stage_quality.cjs --out .local/two-stage/offline
node scripts/two_stage_quality.cjs --holdout --out .local/two-stage/offline-holdout
node scripts/two_stage_quality.cjs --batching --out .local/two-stage/offline-batching
node scripts/two_stage_quality.cjs --live --data-dir <installed-PLUGIN_DATA> --out .local/two-stage/live
node scripts/two_stage_quality.cjs --live --holdout --data-dir <installed-PLUGIN_DATA> --out .local/two-stage/live-holdout
```

Live runs use the installed key only in the proxy process memory. The hook uses a synthetic proxy key in an owned temporary directory. Only reviewed dummy output reaches TypeSafe. A run stops at 120 HTTP calls or 500,000 returned usage tokens by default. Use `--case <id>` for one case and `--relevance-max <0..100>` for a cutoff trial. Reports separate proposed evidence loss from actual loss and check exact saved originals. The runner also saves a CLI quality audit that replays cutoffs with the real local protection rules. Fault runs assert that invalid answers publish no receipt, partial panel, or replacement. These tests prove application behavior for the fixtures, not universal model accuracy.

Batching fixtures cover 251–10,000 lines, long target text, Unicode, escaped JSON, ANSI/CRLF, and unpackable context. All emitted requests must fit both conservative API token bounds. The runner checks exactly-once coverage and complete target text. Later-batch fault cases verify rollback after an earlier valid relevance batch. The current panel accepts multi-batch version-4 snapshots without a 250-target limit.
