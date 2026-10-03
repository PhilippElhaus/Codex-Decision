# API-bounded batching verification — 2026-10-03

Version 0.10.1 removes the 250-candidate-line limit. One Choice classification precedes one or more serial relevance batches. Batch size follows both [documented Jev 1.13 context limits](https://docs.typesafe.ai/models): 32k tokens for state plus the longest question, and 64k for the complete request. See the [packing calculations and API examples](../architecture/design_integrations.md#api-context-budgets).

The public API does not provide a local tokenizer. The hook uses conservative serialized UTF-8 byte-based token estimates and reserves 4,096 units for server framing. These are estimates, not exact token counts. JSON escapes, multibyte text, state, and question overhead all contribute. This avoids a four-characters-per-token assumption. The service can still reject a request; rejection keeps the full original.

Each eligible line belongs to exactly one batch. Target text stays complete. Each batch contains a source window, nearby boundary context, and bounded global diagnostic/first/last anchors. Context-only text may be shortened; targets are not. There is no candidate-line or batch-count cap. Existing limits on physical input size and the 45-second hook deadline still apply.

The hook records cumulative progress but publishes a replacement and successful receipt only after every batch succeeds. A missing or invalid later answer, HTTP rejection, timeout, or storage failure restores the preceding panel snapshot and keeps the complete tool result. Recorded line decisions retain their actual batch IDs. The panel accepts multiple current relevance batches; the quality evaluator includes usage beyond the historical 13-call bound. The retired request packer and its 250-target/12-batch caps have been removed.

## Offline verification

The [base corpus](../../tests/fixtures/two-stage-cases.cjs), [holdout](../../tests/fixtures/two-stage-holdout.cjs), and [batching corpus](../../tests/fixtures/batching-cases.cjs) ran through the real debug hook against a local mock service. The runner checks both budgets on every received request, stage order, complete target text, duplicate targets, complete coverage, exact saved originals, and required-line retention.

The batching corpus includes 251, 300, 400, 1,000, and 10,000 lines; wide target text; Unicode; escaped JSON; ANSI with CRLF; unterminated output; and context that cannot fit. The 10,000-line case completed across **84 relevance batches plus one classification**. Every target was judged exactly once. A source larger than the old request cap now splits into batches instead of being rejected by a line-count limit.

The three final offline runs contain **145 hook invocations**: 64 corpus cases and 27 fault types repeated with each corpus. Faults cover classification errors, first-relevance errors, and failures after an earlier relevance batch succeeds. Later faults include missing/extra IDs, HTTP 422 context rejection, HTTP 500, and timeout. Expected fault errors were 81; assertion failures, lost required lines, and request-budget violations were zero. Faults published no successful receipt, saved original, or partial panel.

Release validation passed 68 Rust tests, 44 Node tests, four Python checks, formatting, and Clippy with warnings treated as errors. Native Edge smoke checks passed at widths 360, 720, 1200, and 2800. The real panel harness now exercises a second version-4 relevance batch and counts classification in its requests. The plugin 0.10.1 and control 0.9.1 archives passed exact source/content verification.

Lab-Control had no free session slot. No unrelated session was stopped or reused. Validation used the documented WSL fallback, the existing locked toolchain, user-local caches, and two build jobs. Native browser profiles were created off the workspace drive and removed by the existing helper.

The subsequent release build used a separate Lab-Control session after capacity became available. It repeated all 68 Rust tests, 44 Node tests, four Python checks, formatting, Clippy, 145 offline cases, and Chromium checks at all four viewport widths. The Linux binaries and both archives were built there, exported, and checked against local source bytes. The owned lab session was then removed. Release 0.10.1 pairs the plugin with control 0.9.2 and adds the exact-hash composer profile for Codex VS Code `26.930.31730`. Patch lifecycle and thread-routing tests cover all three supported Codex builds.

## Live verification

Only synthetic fixtures reached TypeSafe. The proxy read the installed key in memory; the fixture hook used a synthetic proxy key. Each live run retained its 120-call and 500,000-returned-token budget. The requested model was `jev-latest`; recorded responses identified `jev-1.13.0`.

| Measure | Base | Holdout | Batch stress |
| --- | ---: | ---: | ---: |
| Cases | 35 | 19 | 5 |
| API calls | 58 | 37 | 38 |
| Required lines | 541 | 367 | 10 |
| Required lines lost | 0 | 0 | 0 |
| Outputs replaced | 6 | 5 | 0 |
| Net UTF-8 bytes saved | 14,824 | 25,809 | 0 |
| Reported input tokens | 317,149 | 197,216 | 428,688 |
| Reported output tokens | 38,144 | 27,092 | 39,013 |
| Median hook time | 897 ms | 983 ms | 5,009 ms |
| p95 hook time | 3,172 ms | 2,639 ms | 9,616 ms |
| Unexpected errors | 0 | 0 | 0 |

The five live stress cases completed 400 lines in four relevance batches, 1,000 lines in nine, wide lines in seven, Unicode in nine, and ANSI/CRLF in four. They exercised complete coverage without the old cap. No live 10,000-line run was attempted; that size was tested offline.

Across all 133 live requests, both local budget bounds passed and reported input usage stayed below its conservative complete-request bound. The largest observed state-plus-longest-question estimate was 31,369; the largest complete-request estimate was 63,948. This checks observed usage for these requests, not an undocumented tokenizer contract.

## Judgment

The batching defect is corrected: output beyond 250 candidates reaches relevance judgments in bounded requests. Application tests also establish rollback after a later failure. Token accounting remains conservative because the official tokenizer is unavailable. Batch count, latency, and duplicated context increase with the input size; the 45-second deadline can still cause a large live result to remain complete.

The current 5% relevance cutoff remains restrictive. The five live stress cases returned all candidate lines above that cutoff and stayed complete. For the 400-line case, routine scores were commonly 0.07–0.12; the required cause and final value scored 0.90 and 0.94. This does not justify silently raising the default. Receipt replay and new holdouts are needed before changing it.

The 59 live cases preserved 918 labeled required lines. Only 27 labeled lines occurred inside the 11 replaced results. These checks do not establish downstream task success or a general omission error rate. They also do not establish net cost savings: the runs used 943,053 input tokens plus 104,249 output tokens to save 40,633 bytes. The [initial single-request evaluation](two_stage_evaluation.md) is a historical baseline, not the current behavior. Live runs can vary, so this is not a controlled claim that batching changed model quality by a fixed amount.

Run the documented commands in [tests/README.md](../../tests/README.md) to reproduce offline coverage. For a selected live batch test, pass `--live --batching --case many-lines-400,many-lines-1000 --data-dir <installed-PLUGIN_DATA>`. Reports and synthetic receipts remain in ignored `.local/two-stage/` directories. These measurements preceded deployment. See [release 0.10.1](https://github.com/PhilippElhaus/Codex-Jev/releases/tag/v0.10.1) for published packages and upgrade instructions.
