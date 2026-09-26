# Three integration benchmark, 2026-09-26

This benchmark counts model-visible tool text with `tiktoken` 0.14.0 and `o200k_base`. It does not measure Codex billing or a full task. The selected GPT-6 model's tokenizer was not verified.

## Live run

`python3 scripts/benchmark_all_filters.py --mode live --rounds 3`

The run used ten real command outputs for progress, tests, builds, listings, and searches. Each ran three times through the hook with a direct HTTPS Jev request. Six edge outputs also ran through the hook: three oversized, two sensitive-looking, and one malformed result. Each output had a paired run with Jev off. Replacements were checked against saved originals. The failing test's diagnostics and exit summary stayed visible.

| Integration | Results | Jev calls | Replaced | Kept | Skipped | Tokens saved | Reduction on replaced results |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Output filter | 11 | 9 | 9 | 0 | 2 | 48,886 | 95.3% |
| Test/build logs | 14 | 12 | 12 | 0 | 2 | 13,475 | 90.0% |
| Search/listing | 11 | 9 | 3 | 6 | 2 | 8,346 | 71.3% |
| **Total** | **36** | **30** | **24** | **6** | **6** | **70,707** | — |

Jev kept all six search-hit outputs when it was uncertain. Local checks skipped the six edge outputs without a Jev call. The full corpus fell 3.0% by token count because the three oversized outputs dominated it. Results within the configured size limit fell 59.5%. This stress-test mix does not represent a typical session.

The paired median hook time was 162 ms with Jev off and 613 ms with it on: 449 ms added. These times include process start, local checks, HTTPS, and Jev. They exclude model processing and any later read of a saved original.

## Mocked policy run

`python3 scripts/benchmark_all_filters.py --mode mock --per-variant 100`

The run checked 2,104 synthetic cases across the three routes. It made 1,100 mock judgments and found no mismatch against its synthetic labels. It checks routing and replacement rules; it does not measure Jev's judgment accuracy.

Reports: [live JSON](2026-09-26-direct-live.json) and [mock JSON](2026-09-26-mock.json). They contain metadata, without tool text or credentials.
