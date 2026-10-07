# Provider benchmarks — 7 October 2026

Codex Decision 0.11.0 supports OpenAI Decisions (`gpt-6-luna`) and TypeSafe Jev (`jev-latest`). Both providers preserved every required source line in the 64 reviewed live cases per provider. OpenAI saved more output bytes; TypeSafe returned individual requests faster in this run.

| Corpus | Provider | Cases | HTTP calls | HTTP p50 / p95, ms | Called-output p50 / p95, ms | Bytes saved | Required lines lost / reviewed |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Base | openai | 46 | 39 | 698 / 933 | 847 / 2619 | 67,810 | 0 / 737 |
| Base | typesafe | 46 | 46 | 397 / 487 | 522 / 1911 | 55,755 | 0 / 737 |
| Precision holdout | openai | 18 | 37 | 696 / 1770 | 1638 / 3556 | 59,306 | 0 / 123 |
| Precision holdout | typesafe | 18 | 36 | 397 / 476 | 905 / 2010 | 57,412 | 0 / 123 |

The base corpus contains 46 reviewed cases, including cases that intentionally make no API request. The precision holdout contains 18 cases with requested tests, exact values, timing, counts, ordering, Unicode, and provenance. The tables report HTTP latency and full hook latency for outputs that invoked the API. Skipped-output times do not enter those latency figures. HTTP timing includes transmission and response reading; full hook timing also includes packing, local evidence checks, storage, and panel publication.

All four completed runs had zero protocol failures and zero API errors. Both providers kept all 860 required lines across the two splits. The precision holdout recorded 2,144 labeled line judgments per provider. OpenAI retained 159 judged routine lines; TypeSafe retained 237. Some routine lines remain because local rules preserve representatives and context. These are application-output quality measurements, not a claim of universal model accuracy or downstream task success.

The comparison used the same fixtures, 5% relevance cutoff, debug hook, local machine, and provider-specific wire adapters. Requests were sequential within each run. Each run allowed at most 120 proxy calls and 2,000,000 reported usage tokens. An initial OpenAI run reached the old 500,000-token evaluation cap; it is excluded from the table and was repeated with the stated budget. The included measurements are a single completed pass of each split. They are sensitive to network conditions, server load, batching, and classification choices. They do not establish a stable latency ranking.

OpenAI reported 1,149,388 input tokens and zero output tokens across these two completed splits. TypeSafe reported 787,355 input tokens and 84,926 output tokens. Input accounting differs between services, so counts alone do not compare prices. Raw synthetic request/response records and quality replay remain in ignored `.local/benchmarks/`. The [checked-in report](provider_benchmarks_2026-10-07.json) contains synthetic case measurements and no credentials.

Reproduce either split with a private installed key:

```bash
node scripts/two_stage_quality.cjs --live --skip-faults --provider openai \
  --max-tokens 2000000 --data-dir <PLUGIN_DATA> --hook <debug-decision-hook> \
  --out .local/benchmarks/openai-base
node scripts/two_stage_quality.cjs --live --precision-holdout --skip-faults \
  --provider typesafe --max-tokens 2000000 --data-dir <PLUGIN_DATA> \
  --hook <debug-decision-hook> --out .local/benchmarks/typesafe-holdout
```

Offline validation exercised all five corpus splits for each provider: 158 OpenAI cases and 154 TypeSafe cases, with zero failures and zero required-line losses. Fault coverage includes duplicate JSON fields, wrong counts, names and order, refusals, duplicate choice values, malformed distributions, HTTP errors, oversized bodies, timeouts, and rollback after an earlier valid batch. Rust process tests cover private storage and migration. Node tests cover key isolation, configuration, the bridge, and panel state. Browser checks use the real webview code with synthetic data.

Release validation passed 112 Rust tests, 68 Node tests (one optional WSL test skipped in Linux), four Python checks, Chromium and native Edge composer/panel smoke checks, and a 50-round browser layout check with ten fallback transitions. The disposable native VS Code smoke passed renderer loading under the webview CSP, three panel reloads, hide/reopen, session switching, all 72 version-6 rows, and empty activity reporting. Both release archives passed exact file allowlists, source-byte comparison, compiled version checks, and Linux x86_64 ELF checks.
