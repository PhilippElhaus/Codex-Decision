# Selection, reliability, and allocation verification, 2026-10-06

This pass addresses task selection, exact-content guards, malformed inputs,
diagnostic retention, and temporary allocation. It keeps the 5% relevance
cutoff, existing request limits, and application dependencies.

## Reproduced defects

- Clipping the task at 500 characters could hide later exhaustive instructions.
  The reader now retains the full normalized task within its existing record
  bound. Empty, image-only, unsupported, and incomplete latest user records
  cannot reuse an older task. Oversized user-role detection handles whitespace
  across read buffers without allocating the whole record.
  A malformed text block beside valid text also prevents partial evaluation.
- Reopening the transcript after its tail read could mix two different files,
  follow a newly inserted symlink, or block indefinitely on a replacement FIFO.
  The reader now checks one opened regular file and uses that handle throughout.
  Controlled replacements reproduced wrong task selection and a blocked old
  process; the corrected hook retained the opened task and completed each case.
- An extensionless source file, or a source operand beside a `.log` operand,
  could be treated as a log. Those reads stay complete. File-reading tools
  preserve source contents unless every supplied path explicitly names a log.
  File viewers with unsupported shell forms, including heredocs, also stay
  complete. A patch beside summary flags remains complete.
- Long indented diagnostic continuations could become eligible after 24 lines.
  Backtrace frames remain protected until ordinary output resumes. The process
  corpus includes a 100-frame Rust backtrace.
- Duplicate JSON fields could overwrite a model envelope, question answer,
  relevance probability, or explicit disabled setting. The shared parser
  rejects duplicates, including escaped spellings of the same field. A valid
  duplicate-enabled fixture made the old hook send a request despite its first
  `enabled: false`; the corrected hook sends none. Ambiguous code-mode command
  envelopes stay verbatim and cannot qualify for replacement.
- Common credential delimiters with whitespace, JSON quoting, or XML tags
  escaped the existing sentinel check. Synthetic process fixtures now verify
  full output and zero requests for seven additional forms. Harmless fields
  such as `token_count` remain eligible.
- Exhaustive phrase matching found `all paths` inside `install paths`, and
  `all values` inside `small values`. A word-start check prevents these
  accidental matches while retaining explicit exhaustive requests.

The old release and corrected hook were also run against the same reviewed
synthetic precision corpus using live Jev responses. The old hook omitted
107 required lines: 47 from late exhaustive instructions and 60 from mixed
log/source operands. The corrected hook retained them and avoided the
unnecessary requests for those guarded reads.

A later boundary check reproduced another 56 lost source lines through a
`Read` call with an extensionless filename. File-tool, MCP file-read, and
heredoc fixtures now require complete output and zero requests. An explicit
file-tool log read still uses semantic evaluation.

## Allocation and CPU measurements

The benchmark compiles functions from commit `630f3a0` beside the new functions
in release mode with the same dependency versions. The packing comparison keeps
question wording identical to isolate allocation changes; the separate live
trials below measure the prompt clarification. Five hundred randomized packing
cases assert identical batches, target text, question IDs, requests,
and budget checks. Timing uses 41 interleaved samples with allocation
monitoring disabled; allocation totals measure one operation.

| Packing operation | Allocated bytes before | After | Median before | After |
| --- | ---: | ---: | ---: | ---: |
| 100 lines, width 16 | 1,279,573 | 691,081 | 0.961 ms | 0.610 ms |
| 1,000 lines, width 64 | 25,578,238 | 13,752,264 | 20.192 ms | 12.537 ms |
| 10,000 lines, width 16 | 133,150,583 | 72,325,632 | 110.136 ms | 65.656 ms |
| 10,000 lines, width 2,048 | 325,330,268 | 145,274,895 | 258.038 ms | 191.011 ms |

Across twelve tested shapes, packing used approximately half as many
allocations, 45–55% fewer allocated bytes, and 26–41% less median CPU time.
The implementation borrows context slices, searches sorted target numbers,
and moves completed JSON values into the request instead of cloning them.

Plain-text projection borrows the event's existing string. A 256 KiB result
therefore avoids a 256 KiB copy. Five hundred varied event projections matched
the old readable output exactly. One thousand nested valid JSON values matched
the standard parser, and response shapes with 1, 100, and 1,000 answers needed
the same allocation counts under duplicate-field validation. These are local
CPU and allocation measurements, not API latency or billed-token savings.

Transcript scans reuse their bounded record buffer. A 10,000-record synthetic
turn reduced allocation calls from 10,277 to 49 and allocated bytes from
2,353,368 to 431,676. Three isolated repeats with 101 interleaved samples found
6–9% lower median scan time. A 40 MB transcript reduced allocated bytes from
38,007,562 to 524,858 while CPU time stayed approximately equal. Five hundred
varied transcripts returned identical tasks. These comparisons isolate the
handle and buffer changes from the earlier task-selection fixes.

## Decision trials and evidence limits

Prompt trials use explicit required-line and routine-line labels. Required
retention includes both actual and proposed omissions. Routine lines kept
measure missed reduction opportunities in reviewed cases. Structural retention
labels are not treated as calibrated semantic probabilities.

Broader testing rejected a candidate that improved named-test cases but reduced
holdout savings from 63,180 to approximately 46,950 bytes in repeated runs.
Changing the cutoff to conceal retained noise is not part of this pass.

The selected change clarifies that passing tests **not requested by the task**
are routine noise. Instructions, positive criteria, and the cutoff remain
unchanged. Paired live base runs retained all 737 required labels and saved
51,385 bytes before versus 57,512 after. An 18-case comparison included ten
acceptance cases labeled after freezing this candidate: all 123 required labels
survived, routine lines kept fell from 416 to 247, and savings increased from
50,197 to 57,305 bytes. A separate 19-case holdout retained all 367 labels and
saved 63,180 versus 63,110 bytes, a small run-to-run difference. These observed
results support this limited clarification, not a general zero-error claim.

A local review inspected 67 retained receipts and 123 batch states without
exporting private tasks or tool output. It found no obvious missing diagnostic
or patch header and no potential standard delimited credential fields in those
retained records. Historical receipts lack complete ground truth; this review
does not establish a universal omission error rate or downstream task success.

Of the retained receipts, 64 predate this pass: 52 kept the full result, seven
recorded candidates, and five replaced output. Their original and visible
character totals differ by 11,725 characters. Decision counts, omission counts,
protected-line actions, and probability ranges were consistent. These are
retained completed records, not a complete history of failures or skipped calls.
Their different historical policies and modes also prevent treating the
replacement count as an effectiveness rate for the current selector.

## Stability checks

A 110-minute Chromium soak exercised the actual composer and panel scripts:
1,662 rounds, 9,179 layout calls, 1,609,072 visited text nodes, three reloads,
166 fallback checks, and 16 settled-animation checks. It reported no page
errors. Checkpoint heaps did not grow monotonically. The initial large-panel
p95 render time was about 6.4 seconds. Profiling then identified automatic
grid-track sizing as avoidable work: rows already have a fixed height. An
interleaved comparison of five runs per variant reduced median forced layout
from 1,820 to 786 ms and measured browser task time from 6,643 to 5,221 ms.
Settled pixels and geometry matched. The implementation shares the existing
row height between grid tracks and rows; its appearance and animation logic
remain unchanged. Thirty-two comparisons across light/dark themes, four widths,
and 2–10,000 rows matched pixels, row text, tooltips, accessibility labels,
heights, and settled bar values. Large panels remain expensive, and these
synthetic measurements are not a latency guarantee.

A subsequent 2× display-scale run exceeded the lab container's 6 GiB memory
limit while compiled build targets occupied 2.1 GiB of its RAM-backed workspace.
The previous CSS also reproduced a renderer crash under that pressure. After
exporting the binaries and removing only those task-owned build targets, the
final implementation passed 200 scaled rounds with no page errors and two
settled-animation checks. Its sampled panel heap peaked at about 245 MiB.
This separates the lab resource failure from the reviewed layout change; it
does not establish behavior under arbitrary system memory pressure.

The final implementation then completed a fresh 110-minute run at 2× display
scale with reduced-motion preferences and both 121- and 10,000-row panels.
It passed 1,756 rounds, 9,420 layout calls, 1,639,624 visited text nodes,
three reloads, 175 fallback checks, and 17 settled-animation checks with no page
errors. The sampled panel heap peaked at about 300 MiB. Large-panel p95 render
time remained about 6.4 seconds under these conditions. This is endurance
evidence, not a matched timing comparison with the earlier run.

Slow response bodies are tested independently of delayed headers. Choice,
relevance, and later-batch trickle responses hit the existing request deadline,
kept the full result, and published no successful receipt or partial final
panel. The HTTP library already enforces a body deadline; no additional timeout
layer was needed.

The pinned Codex 26.930.61225 profile was verified on a disposable copy of the
actual four native files. Apply, update, JavaScript syntax checks, and exact
restore passed. The new profile retains the established router bindings.

A concurrent-hook stress run exercised 512 invocations in 128 groups of four.
It verified 384 replacements, 128 later-batch failures that kept full output,
and 2,176 mock requests. Readable and typed originals matched exactly. Final
panels preserved the latest completed receipt; no orphaned originals remained.

A longer run enabled pruning with a 1 MB managed-log budget. It exercised
4,096 invocations in 1,024 groups of four: 3,072 replacements, 1,024 later-batch
failures that kept full output, and 17,408 mock requests. Every group's counters
and latest completed panel matched. All readable and typed originals remained
exact; no temporary originals remained after failures. Managed receipts and
batches occupied 999,775 bytes after pruning, within the 1,000,000-byte budget.
The test removed its owned temporary fixture after completion.

Publication under 16 simultaneous 10,000-line outputs exposed the existing
two-second log-lock limit. Both the prior release and the initial implementation
kept some complete results after that limit. Profiling found that encoding and
syncing immutable batch files occupied most of the lock. Batch evidence is now
prepared and synced before locking. The transaction publishes the same bytes
and keeps the existing rollback and durability checks. Panel rows are also
constructed before locking; their publication timestamp is set under the lock.
Private pending files are removed after completion. Recovery removes only
recognized private files older than the outer hook timeout. Fresh, unknown,
linked, and nonregular files remain protected. A focused test exercised the
cross-filesystem copy fallback on two distinct filesystems.

The final mixed-load check ran 128 maximum-size invocations alongside 512
smaller hooks. It verified 504 replacements and 136 deliberate later-batch
failures across 15,632 mock requests. Originals, counters, completed panels,
and pruning matched; no pending originals remained. These resource tests do
not guarantee throughput under arbitrary contention.

The selected implementation passed 108 Rust tests, formatting, and Clippy.
All 154 offline process cases passed across base, precision, holdout, batching,
and fresh splits: 2,558 required labels were retained across 348 mock requests.
The corpus includes 34 fault scenarios, each run once. The Linux Node suite
passed 65 tests with one native-Windows test skipped; four Python checks passed.

Native Windows checks passed 63 Node tests with three platform-specific skips,
including the real WSL UNC permission and snapshot tests. Edge passed the actual
composer, settings, and panel harnesses. An isolated VS Code instance passed
renderer/CSP checks, three reloads, hide/reopen, session switching, protected
rows, and aggregate activity. Its owned Windows profile and WSL fixture were
removed after the check.
