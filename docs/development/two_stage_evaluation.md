# Initial two-stage evaluation — 2026-10-03

This report is the historical single-request baseline. Version 0.10.1 removes its 250-line cap and adds API-bounded batches; see [current batching verification](batching_verification.md). The metrics below apply to version 0.10.0.

Version 0.10.0 implemented one Choice call followed, when approved, by one request containing independent line-relevance Nouls. The composer has one on/off switch. Settings have one relevance cutoff. The old integration categories and omission/exact-text questions no longer select runtime behavior. See the [request and response examples](../architecture/design_integrations.md).

## Final live results

The final code ran against 35 base cases and 19 holdout cases. Both corpora contain reviewed synthetic text. Requests used `jev-latest`; every recorded response reported `jev-1.13.0`. The configured relevance cutoff was 5%. These results are one final pass through each corpus, rather than a sum of repeated calibration passes.

| Measure | Base | Holdout | Combined |
| --- | ---: | ---: | ---: |
| Cases | 35 | 19 | 54 |
| Outputs replaced | 8 | 6 | 14 |
| Required source lines | 541 | 367 | 908 |
| Required lines lost | 0 | 0 | 0 |
| Net UTF-8 bytes saved | 24,662 | 35,104 | 59,766 |
| HTTP calls | 46 | 28 | 74 |
| Input tokens reported by Jev | 219,767 | 152,200 | 371,967 |
| Output tokens reported by Jev | 31,414 | 22,144 | 53,558 |
| Median hook time | 446 ms | 401 ms | 446 ms |
| p95 hook time | 1,137 ms | 1,973 ms | 1,186 ms |
| Unexpected hook/API errors | 0 | 0 | 0 |

The 14 replaced results originally contained 72,753 bytes. Their net reduction was **82.1%**, including replacement headers, omission ranges, and saved-original paths. Across all 742,445 source bytes in the corpus, reduction was **8.05%**. The whole-corpus denominator includes large outputs deliberately kept by the limits. These percentages measure bytes, not downstream model tokens.

Of the 908 required lines, **32 occurred in replaced results**. The remaining labels occurred in results returned intact. All 14 saved originals matched the exact source bytes. This distinction matters: keeping exhaustive files proves the guard worked for those cases, but does not supply hundreds of independent examples of safe omission.

Timing includes local hook work, API requests, and publication. Cases skipped before a request are included. The 25 cases with two calls had a median of 988 ms and p95 of 1,449 ms. This is one observed run, not a latency guarantee.

## Corpus and checks

The [base fixtures](../../tests/fixtures/two-stage-cases.cjs) cover all eight Choice entries, logs from 20 to 240 routine entries, successful builds, failed tests, tracebacks, progress, heartbeats, search subsets, exhaustive search, file inventories, prose, source, diffs, JSON, XML, CSV, distinct measurements, mixed output, injected instructions, Unicode, ANSI color, CRLF, unterminated text, long lines, request limits, metadata, sensitive sentinels, and disabled integration.

The [holdout fixtures](../../tests/fixtures/two-stage-holdout.cjs) add sparse causes at four source positions, expected/actual values, two required ports, packet loss, warnings, two required paths, exhaustive paths, unique measurements, exact repetitive source, mixed explanations, Unicode values, JSONL, limits near 250 targets, missing transcripts, and Monitor mode. Labels identify required source lines; they do not measure whether a downstream agent completed the task.

The [runner](../../scripts/two_stage_quality.cjs) launches the real debug hook. In live mode, a local proxy reads the installed key in memory and forwards only dummy requests to TypeSafe. The fixture hook receives a synthetic proxy key. Each run has a 120-call and 500,000-returned-token budget. The runner retains synthetic requests, responses, receipts, activity, replies, and a report under the requested `.local/two-stage/` directory. It removes its exact owned temporary directory after the run.

For each replacement, the runner checks the saved original, required-line actions, call count, and cases that must remain complete. It also invokes `jevctl evaluate-quality` on saved receipts. Cutoff replay uses the actual protection, representative, and final-line rules. Replays at 1%, 2%, 5%, 10%, and 20% lost no labeled line in these final receipts. This is receipt replay, not a fresh model run or evidence that a higher default is safe.

The offline runs completed **98 hook invocations**: 54 corpus cases and 22 injected fault types repeated with both corpora. Faults include missing/extra answer IDs, incorrect types, invalid class distributions and selections, out-of-range probabilities/confidence, wrong model envelopes, invalid JSON, HTTP 401/429/500/529, timeouts at either stage, and oversized responses. Every injected fault kept the full original and published no successful receipt, partial decision panel, or replacement. Expected fault errors appear in reports; assertion failures were zero.

The final release checks also passed:

- 63 Rust tests, including full hook processes, migration, storage, strict response validation, request boundaries, exact bytes, and CLI replay.
- 43 Node tests for the composer switch, bridge, settings, schema migration, panel validation, and hardening.
- Four Python checks for documentation links and shared defaults.
- Rust formatting and Clippy with warnings treated as errors.
- Native Edge smoke checks at widths 360, 720, 1200, and 2800, with motion settings. Documentation captures use the actual webview scripts and synthetic state.
- Exact archive/source checks for the plugin 0.10.0 and control 0.9.0 packages.

Lab-Control had no available session slot. No unrelated session was stopped or reused. Builds and offline tests used the documented WSL fallback, the existing locked Rust toolchain, its user-local cache, and two build jobs. Edge checks used native Windows temporary profiles. Generated reports and packages remain in the repository's ignored `.local/` locations.

## Calibration observations

The first live pass shortened none of the 35 base results. Requiring 90% probability for one specific class rejected outputs whose probability split between two classes that both allow an excerpt. The current branch checks the normalized combined probability of the four excerptable classes at 95%, while requiring the selected class to be excerptable and a maximum-probability entry. Choice confidence is validated and recorded. It describes concentration between classes and is not the probability of this combined branch.

Explicit true/false relevance criteria improved omission behavior. The service also returned rounded class distributions totaling 0.99. The validator now permits a total within 0.02 of one and normalizes the branch probability. A regression test covers this case and ambiguity between excerptable classes. Invalid distributions still return the full output.

Before the final repeat, the same 19-case holdout shortened seven outputs and saved 37,308 bytes. The repeat shortened six and saved 35,104. The two-port case stayed complete on the repeat because its Choice branch probability fell below the gate. Neither run lost a required line. Conservative model variation affects savings even with identical code and inputs.

Older local data informed fixture shapes only. A bounded read of up to 24 older Codex session files found 416 text tool outputs: 286 had 1–50 lines, 128 had 51–250, and two exceeded 250. Twenty installed receipts were also inspected for tool types and line-count bins. No raw session output or private conversation was exported or sent to TypeSafe. The live corpus remains synthetic.

## Judgment and limits

The pipeline is useful for selective removal of routine log entries. It retained sparse causes and exact required values in the reviewed shortened results. Search subsets can also benefit. It often keeps ordinary build progress and inventory output because relevance scores exceed 5% or the proposed result misses the minimum savings requirement. Shortening is therefore selective.

The measured 0.10.0 baseline was bounded: all second-stage candidates had to fit one request, with at most 250 candidate lines and 128,000 serialized UTF-8 bytes. Larger results stayed complete after classification in that baseline. Structured or coupled formats, uncertain classifications, unsafe task context, API failures, and storage failures also stay complete. Version 0.10.1 now uses a batching design with more than two HTTP calls when needed.

The cost case remains unproven. The final run used **425,525 Jev tokens to save about 60 KB of downstream text**. API tokens and saved bytes are different units. Actual financial benefit depends on both model prices, downstream reuse of the shortened context, and the workload. This evaluation does not claim net cost savings.

The result supports the current conservative behavior and further trials on representative receipts. It does not establish a general omission error rate, downstream task success, or readiness to relax the cutoff. Local source and verified packages are complete; this evaluation did not install, publish, or deploy them.
