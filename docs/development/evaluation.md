# Synthetic evaluation and stress tests

Run commands from the repository root. Reports go under `.local/`.

Use the reviewed output corpus below for live checks. The runner reads the installed key only in memory and sends synthetic output. Review receipts with `decisionctl evaluate-quality --cases <private JSON>` before changing cutoffs.

Use [browser checks](browser.md) for screenshots and UI validation.

```bash
# All seven splits and one complete fault suite for each provider:
node scripts/dummy_matrix.cjs --hook <debug-hook> --jobs 2 --out .local/quality/dummy-matrix
# Individual splits or bounded live checks:
node scripts/two_stage_quality.cjs --out .local/two-stage/offline
node scripts/two_stage_quality.cjs --holdout --skip-faults --out .local/two-stage/offline-holdout
node scripts/two_stage_quality.cjs --batching --skip-faults --out .local/two-stage/offline-batching
node scripts/two_stage_quality.cjs --precision --skip-faults --out .local/two-stage/offline-precision
node scripts/two_stage_quality.cjs --precision-holdout --skip-faults --out .local/two-stage/offline-precision-holdout
node scripts/two_stage_quality.cjs --coverage --skip-faults --out .local/two-stage/offline-coverage
node scripts/two_stage_quality.cjs --classification-holdout --skip-faults --out .local/two-stage/offline-classification
node scripts/two_stage_quality.cjs --live --data-dir <installed-PLUGIN_DATA> --out .local/two-stage/live
node scripts/two_stage_quality.cjs --live --holdout --data-dir <installed-PLUGIN_DATA> --out .local/two-stage/live-holdout
```

Live runs use the installed key only in the proxy process memory. The hook uses a synthetic proxy key in an owned temporary directory. Only reviewed dummy output reaches the selected provider. A run stops at 120 HTTP calls or 500,000 returned usage tokens by default. Use `--case <id>` for one case and `--relevance-max <0..100>` for a cutoff trial. Reports separate proposed evidence loss from actual loss and check exact saved originals. The runner also saves a CLI quality audit that replays cutoffs with the real local protection rules. Fault runs assert that invalid answers publish no receipt, partial panel, or replacement. These tests prove application behavior for the fixtures, not universal model accuracy.

Batching fixtures cover 251–10,000 lines, long target text, Unicode, escaped JSON, ANSI/CRLF, and unpackable context. All emitted requests must fit both conservative API token bounds. The runner checks exactly-once coverage and complete target text. Later-batch fault cases verify rollback after an earlier valid relevance batch. The current panel accepts complete version-6 snapshots up to 10,000 source lines and 8 MiB. It includes earlier batches and protected lines; its row counts must match all recorded totals.

The runner requires a debug or verification hook and rejects the production binary before loading a live key. It reconciles proxy calls, persisted attempts, stage counts, receipts, errors, and completion counters. Eligible offline cases must produce their expected decision; local skips need an explicit expectation. Unexpected live errors stop further requests. Use `--case` with a fault ID for a focused failure rerun. Quality replay tests current relevance cutoffs. Historical receipts retain their recorded evidence-loss report; the retired omission/exact-score engine is no longer executed.

Every report includes `summary.coverage`. It counts distinct outputs, completed
line evaluations, classification keeps, previews, and prepared replacements.
It reports source bytes and skip reasons by tool family and size. Disabled
controls and injected faults have separate denominators. The `--coverage`
holdout pairs supported shell/code-mode wrappers and safe missed opportunities
with privacy, mutation, diagnostic, and exact-content controls. Fixture
expectations require the reviewed safe opportunities to reach evaluation;
paired negative cases must remain local. Offline participation
measures routing with mocked judgments. Live reports also separate proxy
arrivals from provider forwarding. Delivered context savings remain unknown.
Use the [measurement guide](../operations/measurement.md) for counter boundaries and delivery limits.

The independent `--classification-holdout` split tests all eight reviewed format
classes through the semantic classifier. Reports include normalized combined
excerptable probability, confidence bins, gate confusion counts, Brier score,
and calibration error. Offline replies validate the accounting only. Live
synthetic replies measure these eight held-out cases; they cannot establish a
general model error rate. The 95% classification gate and 5% omission cutoff
stay fixed. Deliberate fixture faults never reach a live provider. The coverage
split includes a later-batch adapter fault in its offline run to check whole
batch rollback.

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
node scripts/pipeline_interrupt.cjs --hook .cache/cargo/debug/decision-hook \
  --out .local/quality/pipeline-interrupt
node scripts/pipeline_stage_interrupt.cjs --hook .cache/cargo/verification/decision-hook \
  --require-recovered --out .local/quality/pipeline-staged-retry
node scripts/pipeline_stage_interrupt.cjs --hook .cache/cargo/verification/decision-hook \
  --concurrent-rollback --out .local/quality/pipeline-staged-rollback
node scripts/pipeline_commit_interrupt.cjs --hook .cache/cargo/verification/decision-hook \
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

Build the optimized synthetic hook with `cargo build --locked -p codex-decision --profile verification`. It retains assertions and the loopback endpoint while using optimized packing. Its binaries live under `.cache/cargo/verification/` (or your selected Cargo target directory). Use it for large concurrent pressure checks; an unoptimized debug build can reach the existing 45-second hook limit on a single CPU. Release packaging always builds a separate production profile with the test endpoint disabled.
