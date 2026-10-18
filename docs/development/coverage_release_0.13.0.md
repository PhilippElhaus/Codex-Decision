# Validated output coverage, 0.13.0

Version 0.13.0 fixes the 11 missed opportunities identified in the
[October 18 investigation](participation_evaluation_2026-10-18.md). On the same
original synthetic cohort, API participation increased from **10/32 (31.25%)**
to **21/32 (65.63%)**. All **20/20 reviewed safe opportunities** reached line
evaluation, compared with 9/20 before. The 11 original local-only controls still
made no request. These are paired synthetic results, not a new installed
workload participation rate.

## Runtime changes

- Validate duplicate command envelopes only when text and structured content
  match the known schema exactly.
- Project homogeneous serialized command-result arrays, fulfilled
  `Promise.allSettled` arrays, and separately printed fulfilled records. Retain
  metadata, indexes, per-member boundaries, and the complete typed original.
  Validate every nonempty member's independent-line format before flattening.
  Carry its protected context into the projection.
- Keep the entire response when a member is rejected, unknown, mismatched,
  mixed media, structured, or connected prose. A later provider failure rolls
  back the whole batch, including originals and panel progress.
- Recognize exact passing Cargo test records and reviewed zero-valued
  diagnostic counters. Preserve other diagnostics on the same line, nonzero
  counters, malformed records, backtraces, and completion totals.
- Accept scalar-looking filenames only under verified path-list commands.
  Retain object and array guards. Recognize case-insensitive `.log` and numeric
  log rotations while keeping source and ambiguous suffixes exact.
- Recognize the complete read-only MCP action names `list_commits`,
  `get_deployment_status`, and `lookup_merge_conflicts`. Preserve credential and
  mutation guards and the saved generic MCP replacement policy.

The 95% classification gate, 5% omission cutoff, minimum-size default, provider
selection, fallback setting, and session enablement behavior remain unchanged.

## Live coverage results

The expanded coverage corpus contains 46 offline cases: 44 normal enabled
outputs, one disabled control, and one deliberate later-batch provider fault.
The live runner excludes deliberate faults and sends reviewed synthetic output
only. Its 45-case run used the configured OpenAI provider with `gpt-6-luna`.

| Expanded live cohort | Result |
| --- | ---: |
| Normal enabled outputs | 44 |
| Distinct outputs forwarded to provider | 24 (54.55%) |
| Completed line evaluations | 23 |
| Reviewed safe opportunities evaluated | 23/23 (100%) |
| Local-only controls sent to provider | 0/20 |
| Provider requests | 31 |
| Required labels in prepared replacements | 62 |
| Required labels actually model-judged | 17 |
| Required labels protected before judgment | 45 |
| Proposed or prepared required-line losses | 0 |
| Saved originals verified | 23/23 |
| Prepared projected UTF-8 bytes removed | 42,051 |
| Reported provider input/output tokens | 510,316 / 0 |
| Called-output hook time, median / p95 | 831 / 2,206 ms |

The original paired cohort holds fixture inputs and tasks fixed. Request
expectations and projected line labels change for recovered adapters. All
original typed-response wire byte lengths match; the full original transports
are preserved for each prepared replacement. Projection changes mean that
required-line counts are not directly comparable across the two versions.

Saved originals, hook replacements, and byte estimates do not acknowledge
model-visible delivery. This run does not establish delivered context reduction
or net cost savings. Zero loss on 17 model-judged required facts does not
establish a general omission error rate.

## Independent classifier holdout

Eight new reviewed cases cover all eight output classes through classification.
They were not used to change the prompts, gate, or cutoff. Reports now separate
normalized combined excerptable probability from the selected class's
confidence. They include preset probability bins, confusion counts, Brier
score, calibration error, and actual keep reasons.

The live provider selected the reviewed class in 6/8 cases. It kept all eight
outputs: four true negatives and four false negatives relative to the reviewed
excerptable labels. Six keeps had combined probability below 95%; two selected
a non-excerptable class. No line evaluation or omission followed. Observed
excerptability Brier score was 0.155825 and binned calibration error was 0.195.

This is a small holdout and does not establish population calibration. It
confirms that unknown formats can still stop at classification after reaching
the API. The release improves validated local recognition and leaves that
remaining classifier limitation explicit.

## Validation

- 288 Rust tests passed, with one ignored test. Formatting and Clippy passed.
- 169 Node tests passed, with three platform skips. All 16 Python checks passed.
- The seven-split offline matrix passed 618 invocations and 900 mock requests
  across both provider wire formats. Required-line losses and matrix failures
  were zero. Adapter faults verify whole-result rollback after an earlier
  successful relevance batch.
- Edge and Chromium smoke checks passed. Fifty Chromium layout rounds passed
  with ten toolbar-fallback checks and no page errors.
- Both release packages passed exact allowlisted-content, source-byte, version,
  and binary-target checks.
- The packaged VSIX passed two isolated native Windows launches with eight
  checks each. The checks cover exact hook installation, one registration,
  temporary-failure recovery, startup repair, restart idempotence, provider
  forwarding, and actual panel rendering on Codex `26.1007.21434`.

The eval now records the exact bounded post-commit cleanup deadline message as
a warning instead of inventing a hook error. It retains the warning in reports.
Other stderr diagnostics and actual hook health errors still fail validation.
The bounded runtime cleanup and recovery contract is unchanged.

Lab-Control could not allocate a container because its storage reserve was
insufficient. Builds and checks used the existing locked WSL toolchain, two
Rust build jobs, and normal user-local caches. Local reports remain under
`.local/quality/coverage-release-0.13.0/`. `paired-comparison.json` contains the
original-cohort comparison. `live-classification/` retains the independent
holdout results. Packages remain under `.local/submission/`.
