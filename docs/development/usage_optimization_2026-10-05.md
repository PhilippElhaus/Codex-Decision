# Usage and reduction optimization, 2026-10-05

Jev 0.10.8 sends validated output directly to line judgments. It keeps the
sampled classification gate for unknown formats. Control 0.9.11 distinguishes
a preview from output that was actually shortened.

## Installed activity

The private activity records from October 4 onward contained 376 recorded
API requests, 339 classification skips, 18 completed line-decision results,
and one replacement. That replacement saved 1,661 characters. Seven results
were candidates that kept their full output.

The gate rejected 153 results even though it selected a log, progress, search,
or record class. Most combined probabilities stayed below 95%. Lowering that
threshold would also admit unknown structures. Binary-gate trials did not
resolve the issue at conservative thresholds.

The newest installed Codex extension, 26.930.51102, lacked a composer patch.
The previous extension and control were still present. The active environment
had a trusted hook. A successful API check alone did not establish filtering
for a new thread.

## Changes

- Validate known test/build and search formats before an API request. Send
  their eligible lines directly to Jev. A tool name alone cannot establish a
  safe MCP response format.
- Recognize complete logs and bounded sparse log context. Keep unfamiliar
  factual lines locally. Include those facts as anchors in every relevance
  batch. Mixed prose and unknown structures keep the classification gate.
- Ask whether each line contains a concrete finding needed for the task.
  Routine related text does not automatically count as a finding. The shared
  5% cutoff and the unknown-format 95% gate remain unchanged.
- Keep exact source/diff reads, explicit exhaustive tasks, and impossible
  savings without an API request. A replacement must save more than 256 bytes
  and more than 20% after all feedback headers.
- Support known command envelopes and text-only code-mode results. Protect
  their metadata. Save a complete readable view and the original typed
  envelope before replacement. Unknown fields, annotations, and mixed media
  keep their existing restrictions.
- Record candidate reasons, actual replacements, actual omitted lines, and
  skip counts. `jevctl activity` reads aggregate files without opening raw
  receipts or a key. Missing legacy counters stay unknown.
- Add the pinned composer profile for 26.930.51102. Check all four source
  hashes. Keep separate rollback files for this build.

## Live comparison

The baseline used the source at commit `d2d8dfd`, built as Jev 0.10.7. The
final comparison used the same eight reviewed synthetic cases and the same
5% relevance cutoff. Both runs used the real Jev API. The source and exhaustive
search cases stayed complete. All six compressible cases were shortened in
the final run.

| Measure | Baseline | Final |
| --- | ---: | ---: |
| API requests | 18 | 9 |
| Replaced results | 4 | 6 |
| Saved bytes | 8,418 | 14,017 |
| Jev input tokens | 114,605 | 95,677 |
| Jev output tokens | 11,968 | 11,236 |
| Median case time | 1,086 ms | 640 ms |
| Required evidence lines lost | 0 of 124 | 0 of 124 |

The final code saved 67% more text with half the requests in this comparison.
Returned Jev usage fell by 16%. These are fixture measurements. They do not
predict every future workload or OpenAI billed-token savings.

A separate metadata case was shortened with one request. Its diagnostic,
exit status, saved readable view, and typed JSON original passed exact checks.
The 19-case live holdout kept all 367 required lines. The final sparse-context
run shortened all eight selected cases and retained all 22 required lines.
Additional live cases kept an unprotected INFO finding, resisted an instruction
inside a log, and kept every numbered event when the task required the sequence.
Those three cases retained all 85 labeled evidence lines.

Only synthetic output reached TypeSafe during these evaluations. The runners
held the installed key in memory. They did not copy it to fixtures or reports.

## Validation and installation

- 85 Rust tests passed. Formatting and Clippy passed.
- 148 offline corpus cases passed with no required evidence loss. Invalid
  answers, later-batch failures, and timeouts kept full output and restored
  prior panel state.
- Node passed 65 checks on Linux and 63 on Windows. The remaining checks had
  documented platform skips. The native Windows/WSL state test passed.
- Four Python checks passed.
- Chromium and native Edge passed composer and panel checks. A 100-round
  Chromium layout run passed.
- An isolated native VS Code instance rendered version-6 snapshots under
  its CSP. It passed three reloads, hiding and reopening, thread switching,
  protected rows, actual request counts, and the preview status label.
- A copy of the real 26.930.51102 assets passed apply, update, JavaScript
  syntax checks, and byte-for-byte restore. The live composer patch was then
  applied with its own rollback directory.
- The plugin ZIP and control VSIX passed exact-content and source-byte checks.
  Jev 0.10.8 and control 0.9.11 were installed. Hook trust passed after the
  update. The key, shared settings, and existing session flags were preserved.
- The installed release hook made one real Jev request for a synthetic
  command envelope. It omitted 79 lines, saved 2,361 characters, and retained
  exact diagnostics, metadata, and the complete typed original.

Reload VS Code and start a new local thread to load the updated control and
hook. Existing running threads can retain their earlier loaded version.
The previous plugin source, packages, and composer assets remain available
for rollback. New aggregate counters measure subsequent work; they do not
rewrite historical results.

Evidence stays in the ignored `.local/optimization-20261005/` directory and
the task's private verification sessions. No private conversation or tool
output is included in this report.
