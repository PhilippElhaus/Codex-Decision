# Extensive Jev verification, 2026-10-04

Plugin 0.10.7 and control 0.9.10 preserve the composer and complete-panel repairs
and improve large-output performance and deadline recovery. The control's
renderer is unchanged; its metadata selects the new hook version.

## Findings and changes

A 10,000-line offline case hit the 45-second hook deadline while debug code
and continuous browser rendering competed for a one-CPU Lab-Control container.
The old rollback and error-reporting paths also required unused invocation time.
Consequently the failed hook could leave its processing snapshot visible and
omit the deadline reason from health telemetry.

Rollback and error reporting now use separate locks bounded to 250 ms each.
Tests expire the invocation deadline explicitly and verify both an empty panel
and restoration of its previous snapshot, plus the recorded error. Ownership
checks still prevent rollback from replacing another receipt's snapshot.

Batch packing uses the previous validated target count as a hint and checks
both API budgets again. A variable-width regression verifies shrinking and
growing windows, exact target coverage, and complete target text. Outputs of
1,000 lines or more publish the first and final batches and intermediate panels
at most once per second. Final receipts and snapshots retain all judgments.
Smaller outputs still publish every batch. Another regression checks the
first, final, periodic, and small-output publication rules.

The corpus report now includes bounded hook stderr when the health record has
no error, so an expired hook is no longer reduced to an uninformative
`hook error`.

## Verified rendering and live calls

The installed 0.10.6 hook made two real API requests on synthetic data in the
current session and produced a fresh 73-row decision. The rows include one
decoded command-metadata line, 70 routine lines, an error, and completion.
All source lines remain in order. Three protected rows show no invented score.
The code-mode response envelope remains complete. The real renderer displays
`4 / 73 kept` without overflow. A captured 28 px composer gap with a 44 px
model control places the indicator on the toolbar row.

An isolated native VS Code host passed the panel's actual webview CSP, three
document reloads, hide/reopen, thread switching, the 72-row protected-line
fixture, and classification-only activity. Native Edge passed the composer
and current/historical panel fixtures. Chromium passed the same smoke suite.

The Windows Node suite passed 60 tests with three platform or privilege skips.
Coverage was 95.72% of lines and 88.12% of branches; panel-provider line coverage
was 100%. Linux Node passed 64 tests with one Windows-only skip. All four Python
checks and all 76 Rust tests passed. Rust formatting and Clippy passed.

The continuous Chromium run completed 2,612 composer and panel rounds in
1,801 seconds, at device scale 2 with reduced motion. It rotated 92-row and
242-row hook snapshots and exercised viewport widths from 360 to 2,800 px,
tight gaps, tall model controls, and 5,000 synthetic history items. All 26 panel
reloads, 261 toolbar fallback/recovery checks, and 104 settled-score checks
passed. No page errors occurred. Panel render p95 was 788 ms and layout p95 was
77 ms under shared one-CPU contention; these are stress measurements, not an
idle performance baseline. The captured 73-row panel used about 2.0 MB of
JavaScript heap after forced garbage collection.

With the competing browser and build work finished, all 145 offline, holdout,
and batching cases passed across 432 mock API calls. No required evidence was
lost. The 10,000-line case completed in 4,816 ms over 121 relevance batches,
rendered all 10,000 panel rows, matched its receipt, retained both required
lines, and saved an exact original. The under-contention debug timeout remains
recorded separately; its repaired failure path restored the panel and kept
the complete tool result.

The Linux release build and both archives passed exact-entry, source-byte,
version, and target checks. Exported binaries and packages were checked against
their recorded SHA-256 hashes before being copied into the checkout's ignored
release locations. The release version check ran in Lab-Control, where Cargo
is available.

## Evidence and limits

Generated logs, receipts, native reports, snapshots, screenshots, and manifest
hashes are retained in `.local/quality/extensive-20261004/`. They use synthetic
tool data. The live test invoked the installed hook directly; it does not
prove automatic event dispatch in this continuing conversation.

The user confirmed this VS Code window had not been reloaded or replaced by a
new Codex thread. Its old automatic hook record was from 0.10.2. Reload the
window and start a new local thread to activate the installed control and hook
for normal tool calls. Check hook trust separately from API health. No key,
trust selection, session switch, or shared setting was edited for these tests.

The offline corpus runner requires a debug hook that supports its loopback
test endpoint. Production release binaries ignore that override. An attempted
offline test against a production binary was rejected by the real API because
it used the synthetic fixture key; that attempt is excluded from successful
corpus counts and live-key verification.
