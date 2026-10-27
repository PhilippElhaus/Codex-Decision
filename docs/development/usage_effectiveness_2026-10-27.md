# Usage and effectiveness audit, 2026-10-27

Decision prepares substantial reductions for outputs that reach line evaluation.
Its recorded provider work is dominated by classifications that keep full output.
Delivered context savings remain unverified. The strongest immediate improvement
is better measurement of local skips, failures, and the host delivery boundary.

## Scope and method

The read-only audit ran on October 27, 2026, from 08:52:00 to 08:52:25
Europe/Berlin. The Windows VS Code settings selected WSL and identified the
canonical installed Decision data directory. The installed WSL plugin was enabled.
The audit excluded the retired Jev data directory and read no credentials.
It made no provider requests and changed no runtime settings.

The [audit reader](../../scripts/usage_effectiveness_audit.cjs) found 86 session
scopes, including 80 with hook health and six without recorded calls or completed
evaluations. Fifty-one scopes had exact health and activity accounting. The
matching rollout inspection covered 77 scopes; nine plugin scopes had no matching
rollout file. Active use continued during the observation.

The recent slice starts at `2026-10-20T00:00:00Z`. Supplemental aggregates stop
at the baseline's latest retained event, `2026-10-27T07:51:48.625Z`. Twenty
session scopes had events in this slice. All 9,149 retained recent events use
event schema version 3. This schema version does not identify the hook build.
The latest health records for these scopes name 0.13.0 (one), 0.14.0 (two),
0.14.1 (ten), and 0.15.0 (seven). These latest versions cannot identify the
producer of each historical event.

Reproduce the baseline with the directories identified by the actual installation:

```sh
node scripts/usage_effectiveness_audit.cjs \
  --data-dir /absolute/installed/plugin-data \
  --codex-sessions /absolute/codex/sessions \
  --observation-date 2026-10-27 \
  --since 2026-10-20T00:00:00Z
```

The reader exports counts and allowlisted categories. Supplemental inspection
also exported only aggregate latency, size, format, and storage categories.
No task text, command text, result text, session identifiers, or private paths
appear in this report.

## Lifetime participation with exact accounting

These counts cover the lifetime of the 51 exact-accounting scopes. They are
not a recent-window rate or a random sample of ordinary workload.

| Measure | Count | Share of enabled invocations |
| --- | ---: | ---: |
| Enabled invocations | 107,885 | 100% |
| Skipped outputs, including classification keeps | 106,123 | 98.37% |
| Completed line evaluations | 1,682 | 1.56% |
| Hook errors | 80 | 0.074% |
| Prepared replacements | 1,131 | 1.05% |
| Previews | 469 | 0.43% |
| Completed evaluations with no omission | 82 | 0.08% |
| Classification keeps after an API answer | 7,463 | 6.92% |
| API request attempts | 9,426 | 8.74 attempts per 100 invocations |
| Validated API answers | 9,346 | — |
| Recorded request failures | 80 | — |

The invocation outcomes reconcile exactly: 106,123 skips + 1,682 completed
evaluations + 80 errors = 107,885 invocations. There were no cancelled request
intents. Of 9,384 received responses, 9,346 validated; 42 attempts had no
recorded received response. The 38-response difference and 42-attempt difference
sum to 80 failures. This is counter reconciliation, not a diagnosis of failure
causes. Current history does not retain a complete error-class or failed-latency
distribution.

At least 9,145 and at most 9,426 outputs reached an API attempt: **8.4766–8.7371%**
of enabled invocations. One output can use several requests. Classification
keeps already used the API. Attempts can fail before reaching the provider.
The [October 18 baseline](participation_evaluation_2026-10-18.md) reported
8.04–8.44%, but the cohorts and retained versions differ. Their difference is
not a controlled before-and-after result.

| Exact-cohort skip reason | Count | Share of enabled invocations |
| --- | ---: | ---: |
| Small output | 39,504 | 36.62% |
| Exact source or diff content | 20,418 | 18.93% |
| Unsupported route | 11,147 | 10.33% |
| Unsupported result envelope | 8,687 | 8.05% |
| Structure guard | 8,275 | 7.67% |
| Classification kept full output | 7,463 | 6.92% |
| No eligible lines | 3,925 | 3.64% |
| Sensitive output, command, or input | 2,929 | 2.71% |
| Unsafe task context | 1,750 | 1.62% |
| Insufficient possible savings | 1,038 | 0.96% |
| Generic MCP replacement disabled | 965 | 0.89% |
| Tool-input budget | 22 | 0.02% |

Small output and exact reads account for 55.54% of invocations. Unsupported
routes and envelopes account for 18.38%. The latter is an investigation ceiling,
not a measured recoverable gain: retained local skip counters cannot identify
their tool, format, version, or source size. At least 94,735 invocations, 87.81%,
skipped locally before an API request.

## What recent use produced

The recent slice contains 4,595 evaluation-start events and 4,554 recorded
completion events. Start and completion events have no shared invocation ID.
The 41-event difference cannot be assigned to failure, interruption, boundary
effects, or missing history. Most ordinary local skips do not produce dated
events, so this slice has no complete invocation denominator.

| Recent recorded outcome | Outputs | Request attempts | Reported input tokens | Recorded processing time |
| --- | ---: | ---: | ---: | ---: |
| Classification kept full output | 3,985 | 3,985 | 4,548,618 | 1,700,463 ms |
| Prepared replacement | 397 | 433 | 3,517,901 | 270,951 ms |
| Preview: insufficient final savings | 138 | 143 | 988,268 | 83,715 ms |
| Preview: missing task context | 4 | 4 | 10,221 | 1,951 ms |
| Completed, no omissions | 30 | 32 | 192,139 | 17,284 ms |
| Total | 4,554 | 4,597 | 9,257,147 | 2,074,364 ms |

These are recorded outcome requests, not a complete recent ledger of failed
attempts. The usage fields report zero output tokens for these events; this is
the recorded provider field, not an independently verified billing statement.
Processing time is the recorded sum of provider evaluation durations. It does
not include complete hook startup, preparation, persistence, or host delivery.

Classification keeps account for **87.51% of recorded completed outputs**,
**49.14% of reported input tokens**, and **81.98% of recorded processing time**.
All 569 completed line evaluations used locally validated formats. They name
OpenAI and record no fallback use. Of these, 532 used one relevance batch, 33
used two, three used three, and one used five. Extra batches therefore explain
only a small part of the recent request volume. Classification-only events
do not record their actual provider or fallback identity.

| Recorded outcome | Timed outputs | Median | 95th percentile | 99th percentile |
| --- | ---: | ---: | ---: | ---: |
| Classification keep | 3,985 | 374 ms | 781 ms | 1,397 ms |
| All completed line evaluations | 569 | 568 ms | 1,313 ms | 2,100 ms |
| Prepared replacement | 397 | 576 ms | 1,421 ms | 2,110 ms |
| Insufficient-savings preview | 138 | 537 ms | 1,216 ms | 1,776 ms |

Percentiles select the sorted observation at index `floor(count × percentile)`.
These successful-outcome distributions exclude failed attempts and full hook
overhead. They cannot establish end-to-end tail latency.

The dated completion counts show sustained use:

| UTC date | Classification keeps | Completed line evaluations | Prepared replacements |
| --- | ---: | ---: | ---: |
| October 20 | 304 | 23 | 13 |
| October 21 | 566 | 84 | 48 |
| October 22 | 733 | 155 | 83 |
| October 23 | 323 | 45 | 28 |
| October 24 | 585 | 93 | 85 |
| October 25 | 487 | 43 | 29 |
| October 26 | 984 | 126 | 111 |
| October 27, partial day | 3 | 0 | 0 |

### Why classification keeps dominate

Of the 3,985 classification keeps, 2,680 selected mixed or unknown output,
541 prose, 300 exact content, and 58 structured payload. These four protected
classes account for 89.81% of classification keeps. The remaining 406 selected
an excerptable class but failed the existing combined 95% probability gate:
229 repetitive logs, 79 independent records, 39 independent matches, and 59
progress outputs.

Only two of those 406 had combined excerptable probability between 90% and
95%. Fifty-four fell between 75% and 90%, 264 between 50% and 75%, and 86 below
50%. This distribution does not support lowering the confidence gate.

The tool families were 3,845 shell results and 140 web results. Source sizes
were 1,206 outputs at 256–1,023 characters, 1,364 at 1,024–4,095, 1,085 at
4,096–16,383, and 330 at 16,384 or more. This supports a focused review of
recognition before classification, particularly for small prose and coupled
formats. It does not establish that any individual protected output could
safely omit lines.

### Typical prepared output and preservation

The 397 recent replacement receipts contain 1,927,464 original UTF-8 bytes and
793,754 prepared visible bytes: **1,133,710 bytes, or 58.82%, less payload**.
They propose 7,958 omitted lines. This is prepared reduction, not delivered or
billed-token savings. Thirty-five receipts contain an explicit synthetic,
dummy, or fixture marker. Unmarked records can also be verification traffic.

Aggregate receipt inspection found these typical categories, without exporting
private lines:

- 241 outputs contain line-numbered search matches.
- Eight contain passing Rust test rows; four contain passing test summaries.
- The remaining 144 contain other independent-line output under the existing
  validated format contract.

A separate command-family heuristic identified text search in 323 receipts,
file listing in 21, Python tests in 32, Node tests in four, and Rust tests in
three. Fourteen were other or unparsed commands. These broad heuristic groups
can include scripts that run several tools; they are descriptive, not routing
or correctness labels. The event tools are 392 shell results, one native Lab
result, and four tool names outside the audit's allowlist.

Across retained history, 1,204 published replacement receipts were available.
All 1,199 current-format saved-original references resolve to exactly matching
bytes. Five legacy receipts lack the current reference format. No current-format
original was missing or mismatched. At least 153 retained replacement receipts
have explicit fixture markers.

This validates original preservation for the inspected records. It does not
measure whether every omitted line was irrelevant to its task. There is no
reviewed task-specific evidence label set for this live cohort.

## Delivery and storage limits

Matching rollouts contain 36,401 unique tool-result items across 77 scopes.
Normal calls predominantly use code-mode `exec` and `wait`. None of the inspected
tool-result items contains a complete rendered Decision or Jev omission header.
A prepared hook replacement does not prove delivery to the model. The absence
of headers in rollout result items also does not prove that separate hook
feedback was absent. Normal-session delivered context reduction remains
unverified.

At supplemental inspection, session log trees contained about 79.6 MB across
4,427 files. Receipt JSON accounted for about 19.9 MB across 1,944 files. Saved
originals contained 6,049,704 readable bytes in 1,282 files and 76,522 typed
bytes in 11 files. These are observed retained sizes, not a storage-growth rate.
No event tail exceeded the audit reader's 1 MiB per-scope read bound.

Useful next measurements are per-invocation metadata for ordinary local skips,
error categories and failed timings, actual provider and fallback on every API
outcome, hook build on every record, phase timings, byte counts, request/batch
counts, and an explicit statement of delivery evidence. Raw task and output
capture is not required for these aggregates. Bounded retention and explicit
coverage must remain part of the contract.

## Recommended low-effort improvements

The source changes accompanying this report add private, metadata-only
`logs/telemetry.jsonl` files and an [offline analyzer](../../scripts/telemetry_audit.cjs).
Random invocation IDs join starts, provider attempts, and terminal outcomes.
Records include build and runtime, configuration, tool family, output sizes,
skip and failure codes, provider and fallback, HTTP status, request and response
bytes, reported token usage, latency, and prepared savings. They contain no
raw commands, tasks, outputs, endpoint URLs, or credentials. Delivery remains
explicitly unverified.

Each session's metadata stays within 4 MiB. Collection uses a separate
nonblocking lock and cannot change the filter's result. With no-delete logging,
collection stops at the cap. The analyzer reports incomplete correlations and
measurement coverage instead of treating missing rows as zero. See
[data handling](../architecture/design_data.md) for the full contract.

The estimates below are engineering judgments, not measured delivery promises.
The telemetry expansion implemented with this audit is separate from this list.
It is a source change until a rebuilt runtime is installed. The new metadata
cannot fill gaps in historical records.

| Priority | Improvement | Evidence and expected impact | Estimated effort | Acceptance measure |
| --- | --- | --- | --- | --- |
| 1 | Add a host delivery canary for a direct tool result and `exec`/`wait` wrappers. Compare the model-visible result with its prepared receipt. | There are 397 recent prepared replacements, but delivered savings remain unverified. A bounded synthetic canary would expose integration regressions early. | 0.5–1 day | A supported host build proves the expected result boundary; the report keeps prepared and verified delivered bytes separate. |
| 2 | Add narrow local keep fast paths for clearly validated prose, exact content, and coupled formats. Keep their full output before classification. | Protected classes account for 3,579 of 3,985 recent classification keeps. Classification keeps used 82% of recorded processing time. The recoverable share requires a paired test. | 0.5–1 day | Fewer requests on a reviewed corpus; zero new sends or omissions on protected controls; unchanged 95% classification gate and 5% omission cutoff. |
| 3 | Shorten repetitive classifier instructions and criteria before reducing evidence samples. | Recent classification keeps consumed 4.55 million reported input tokens. Constant wording affects every classification. | 0.5–1 day | Compare bytes, provider usage, latency, and branch decisions on a frozen corpus and a fresh holdout for both provider schemas. |
| 4 | Share unchanged session activity reads between composer and panel controllers. Reuse parsed records when file fingerprints remain stable. | The extension polls active views each second and can repeat the same private-record reads. This is unnecessary local work during long sessions. | 0.5–1 day | Fewer reads during idle polling; unchanged focused-thread state, journal recovery, and atomic publication behavior. |
| 5 | Parse and validate a command or Lab result envelope once per invocation, then reuse its view. | Protection, supported-route checks, and replacement checks reconstruct the same command view. Removing repeated parsing reduces allocation and code duplication. | 0.5–1 day | Identical projection and preservation behavior on nested-envelope, malformed, and mixed-result fixtures; lower parse/allocation cost in a focused benchmark. |
| 6 | Share a credential snapshot and health probe for one connection within an extension host. | Settings read credentials repeatedly, and separate live views maintain health probes. Sharing work reduces file reads and duplicate connection checks. | About 0.5 day | One shared probe per connection interval; edits and provider changes invalidate the snapshot; view errors and key redaction remain correct. |
| 7 | Measure receipt-retention scans, then bound repeated scans under the session log lock. | Completion performs retention work under the same lock as publication. The observed session log trees contain 4,427 files. A bounded cadence or incremental inventory may reduce contention. | 0.5–1 day | Measure lock hold and wait times first; then show a reduction while retaining disk limits, originals, publication recovery, and concurrent-reader correctness. |
| 8 | Add explicit current relevance and final-protection counters with new names. Preserve the legacy counter's meaning. | `lines_below_omit_cutoff` counts the retired `below_omit_cutoff` reason. Current line decisions use `irrelevant` or `task_relevant`; the existing field does not describe the current threshold population. | About 0.5 day | A receipt distinguishes judged lines below the current threshold, lines restored by protection, proposed omissions, and prepared omissions. Old readers retain their existing interpretation. |

These changes keep the privacy boundaries and omission policy intact. Their
benefits should be measured with the new metadata before broadening their scope.

## Validation of the telemetry change

Validation ran in a separate Lab-Control Ubuntu session. The Rust suite passed
307 tests, with one ignored test. Formatting and Clippy passed. The Node suite
passed 226 tests, with four platform or optional integration skips. All 16 Python
checks passed. Native Windows execution was not tested in this run.

Regressions exercise successful replacements, failed later batches with full
rollback, HTTP and protocol failures, transport failure, fallback in both
directions, private metadata, bounded retention, nonblocking contention, and a
committed replacement whose metadata destination is unsafe. The offline reader
tests malformed UTF-8, duplicate keys, fractional and inexact counters, changing
files, partial windows, missing request rows, and linked-file rejection.

A separate synthetic check ran 45 short-output hook processes and passed their
new logs through the actual offline CLI. It found 45 starts, 45 completions,
zero requests, and zero malformed rows. A small debug-build comparison used five
warmups and 40 alternating measured processes per build. Baseline and new median
process latency were 3.869 and 3.950 ms; their p95 values were 10.544 and
13.030 ms. This noisy container check does not establish production overhead or
a tail-latency guarantee. It confirms the complete hook-to-audit path without
contacting a provider.

At audit completion, these changes were uncommitted and no installed runtime,
provider configuration, credential, filtering setting, or release had changed.
The telemetry and four selected maintenance improvements are included in
[version 0.15.2](maintenance_0.15.2.md). Collection starts when that runtime is
installed and enabled hook processing resumes.
