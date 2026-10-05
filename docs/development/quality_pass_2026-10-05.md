# Reliability and allocation improvements, 2026-10-05

Jev 0.10.10 keeps the 0.10.8 routing rules, prompts, cutoffs, and resource
limits. This pass fixes failed-publication recovery and overlapping hooks,
reduces temporary allocations, and removes duplicated CI fault runs.

## Reliability fixes

- An original belongs to an invocation until its receipt commits. Failed
  envelope or receipt writes now remove only files created by that invocation.
  Existing files remain intact, and the same tool call can be retried.
- Live panel publication captures the latest completed snapshot under the log
  lock. A hook defers its live updates while another hook owns the processing
  panel. Rollback cannot revive an abandoned processing panel or overwrite a
  newer completed result. Deferred hooks still publish complete final receipts.
- Configuration, health, statistics, credential, and rollback reads share a
  bounded reader. It checks the opened file, rejects links and special files,
  and caps the actual read even if a file grows after its initial size check.
- Publication checks the invocation deadline between writes. Rollback remains
  available after that deadline; committed output survives telemetry failures.
- Unsupported or incomplete ANSI sequences remain verbatim in Jev's view
  without duplicating their preceding text. Saved source bytes remain exact.

The publication, overlapping-panel, and ANSI regressions failed against the
previous implementation before their fixes. Tests also exercise existing-file
conflicts, retries, deferred completion, file-size boundaries, and a FIFO that
must fail without waiting for a writer.

## Less temporary work

Relevance decisions read the existing batch map directly. Duplicate-line
protection borrows source text instead of cloning it. Known command envelopes
project their output without serializing and parsing it again. A redundant
diagnostic-protection pass was removed.

Request budgeting runs the same JSON encoder into a byte counter. It counts
Unicode, escaping, question overhead, and the existing 4,096-token reserve
without allocating encoded buffers during each packing probe.

The benchmark compiles the previous functions from commit `2bfd9be` beside the
new release-mode functions. It asserts identical decisions, budgets, and
batches. Allocation totals cover one operation; timing uses 21 samples of five
operations with allocation monitoring disabled.

| Synthetic operation | Allocated bytes before | After | Median time before | After |
| --- | ---: | ---: | ---: | ---: |
| 10,000 unique kept lines | 5,889,810 | 2,786,504 | 8.94 ms | 6.97 ms |
| 10,000 unique omitted lines | 2,701,630 | 2,199,326 | 5.17 ms | 4.74 ms |
| 10,000 repeated kept lines | 4,229,182 | 1,412,648 | 3.70 ms | 2.99 ms |
| 10,000 repeated omitted lines | 4,199,648 | 1,383,114 | 4.85 ms | 3.99 ms |
| One request budget | 344,288 | 0 | 0.147 ms | 0.133 ms |
| Pack 1,000 wide lines | 32,621,735 | 18,758,247 | 16.13 ms | 14.62 ms |

The budget check eliminates 329 allocations for that request. These are
synthetic CPU and allocation measurements, not end-to-end API latency or
billed-token savings.

## Lean verification

CI runs all 67 reviewed output cases and all 27 fault scenarios. Holdout and
batching runs use `--skip-faults` because their appended fault suites were
identical to the base run. This removes 54 duplicate cases and 74 duplicate
mock requests without removing a scenario.

CI uses Ubuntu 24.04, matching the release build platform. This prevents the
announced October migration of `ubuntu-latest` from silently changing the
operating system used for verification.

The real 0.10.8 debug hook and the final hook were compared on the same corpus.
All 94 case outcomes, 16,497 line decisions, saved readable output, and 235
recorded request bodies matched. The comparison ignores timestamps, generated
IDs, and temporary original paths. All 1,066 required evidence labels survived;
the 279 mock API requests produced no protocol or packing failures.

Release checks include Rust tests, formatting, Clippy, Linux and native Windows
Node tests, Python checks, exact package contents, the real webviews in Chromium
and Edge, an isolated native VS Code panel, and an installed-hook smoke test.
Control 0.9.13 binds the release to hook 0.10.10; its application code is unchanged.

All 90 Rust tests passed. A separate process stress run exercised four concurrent
hooks in one session across eight groups: 24 replacements, eight later-batch
failures, and 136 mock requests. It checked exact readable and typed originals,
complete receipts, no orphaned originals, and the latest completed panel after
each group. The same schedule reproduced stale-panel rollback with 0.10.8.
