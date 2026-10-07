# Pipeline optimization — 7 October 2026

Baseline: commit `4b24210`. This report records validation before release. The pass covers the intercepted hook event, local guards, classification, relevance packing, provider requests, response validation, exact-span rendering, private publication, retention, and panel rendering. Core, browser, and package checks passed. VS Code's updater blocked the revised renderer's native rerun; Edge and Chromium passed.

## Preserved behavior

Keep the 5% relevance cutoff, eight classification classes, normalized 95% branch gate, route guards, provider selection, timeout limits, and minimum savings rules. Preserve complete targets, context, source order, protected evidence, canonical private records, and exact readable and typed originals. A failed assessment or publication leaves the complete result visible. Saved user data and deployment rollback files remain intact.

## Changes and evidence

| Stage | Result | Evidence |
| --- | --- | --- |
| Input and configuration | Keep existing input, duplicate-field, transcript, sensitive-input, and source limits. Count serialized tool-input bytes without allocating the encoded representation. | Process guards and exact serialized-size boundaries. |
| Command projection | Borrow metadata during serialization. Reuse its string for the protected metadata line and exact output. Reserve the complete prefix, separator, and output before insertion. | 480 complete baseline byte comparisons, large output and metadata fixtures, and command-envelope process checks. |
| Private initialization | Apply mode 700 when creating Unix directories. Concurrent first hooks cannot observe a temporary public mode. Existing public directories still fail validation. | 32 rounds with eight concurrent initializers; real concurrent hook processes. |
| Source normalization | Keep the original byte scanner, diagnostic predicate, and ANSI parser. Group source helpers in dedicated modules. Preallocation and ANSI fast-path candidates had mixed CPU results and were rejected. | 500 frozen span, protection, and representative comparisons; repeated ordinary, colored, and unsupported-escape benchmarks. |
| Classification | Keep the existing local format bypass, eight classes, and branch calculation. Retain the established questions after live alternatives failed consistent quality checks. | Classification, structure, precision, and protocol faults; bounded live trials below. |
| Packing | Use exact prefix costs during window fitting. Borrow source rows and reuse question costs for equal number widths. Build only selected requests and retain a separate final serialized-size guard. | 1,700 window comparisons against the encoder; 1,000 complete seeded comparisons against the baseline. |
| Provider encoding | Serialize borrowed OpenAI question and choice views directly into the outgoing buffer. TypeSafe serializes its existing request. Keep the public wire-value conversion compatible. | 1,000 generated complete byte comparisons across both providers, exact validation errors, budget checks, and request fingerprints. |
| Response normalization | Move validated names, probabilities, and usage into the existing named evidence representation. | Frozen baseline comparisons of complete normalized values, bytes, and errors. |
| Rendering | Write omission markers directly. Use one representative map instead of separate count and seen maps. Keep original spans, line endings, ANSI sequences, representatives, and final lines. | 500 complete render comparisons, source/representative comparisons, and exact originals in process cases. |
| Evidence encoding | Serialize borrowed receipts, batches, and panel rows through bounded writers. Cap buffer growth and stop oversized encoding at the existing limits. | Canonical bytes for optional fields, signed zero, Unicode, controls, and usage; buffer-growth and boundary tests. |
| Publication | Prepare bulk receipt and panel bytes before the session lock. A serde marker records the exact timestamp range. Keep timestamp insertion, ownership, stats, rollback, and commit checks under the lock. | Timestamp and decoy-field tests; overlapping hooks, staged publication, and 10,000-row fixtures. |
| Retention | Read event tails through one regular, nonblocking, no-follow handle with a 1 MiB limit. Compare borrowed paths during sorting. Delete only recognized private receipt and batch files. | Oldest-first and tie cases; unknown, public, linked, and special-file cases. |
| Panel rendering | Reuse header and row nodes across results. Keep the row pool within the validated snapshot limit. Release it when the panel clears. Remove redundant full-snapshot serialization; same-ID updates still change only the header. | Chromium and native Edge fixtures retain every row, score, tooltip, protected label, and animation. New checks cover result shrink, growth, changed text and scores, and empty restoration. A one-hour resident-message run passed. |

## Performance checkpoints

Release-profile measurements use the same compiler and locked dependencies. Baseline and candidate builds use separate Cargo target directories. Executables are frozen before comparison. The reviewed packing checkpoint uses baseline, candidate, candidate, baseline order. Every complete fixture fingerprint matched. Input preparation is excluded from response-normalization timing. These are the reviewed local stage measurements; they do not measure remote API latency.

| OpenAI packing fixture | Allocated bytes before | Allocated bytes after | Median CPU before | Median CPU after |
| --- | ---: | ---: | ---: | ---: |
| 100 lines, width 16 | 5,278,112 | 346,669 | 3.117 ms | 0.313 ms |
| 1,000 lines, width 64 | 24,469,208 | 3,307,087 | 13.549 ms | 3.414 ms |
| 10,000 lines, width 16 | 170,518,905 | 32,476,640 | 93.488 ms | 38.817 ms |
| 1,000 lines, width 2,048 | 48,492,434 | 6,229,725 | 24.719 ms | 18.410 ms |

The wide fixture exercises the library and exceeds the normal 2,000,000-byte source limit. It is not an end-to-end throughput claim. TypeSafe packing improved by 1.8–7.5 times across these fixtures. Complete requests, batch boundaries, and question wording stayed identical.

OpenAI budget checks allocate no buffers. Initial answer normalization reduced 121–905 allocations to 1–13 and 16,896–131,208 allocated bytes to 632–8,312. Its CPU medians fell from 6.4–62.8 to 2.5–20.7 microseconds.

The direct wire encoder comparison uses the prior intermediate wire-value path in the same candidate crate. One OpenAI relevance fixture fell from 812 allocations and 312,059 bytes to 282 allocations and 250,493 bytes. Initial median CPU fell from 174 to 149 microseconds. A Choice fixture fell from 72 to 15 allocations and from 21,033 to 12,533 bytes. Every comparison asserts identical complete wire bytes.

| Private encoder, 10,000 lines | Allocations before | Allocations after | Allocated bytes before | Allocated bytes after | Initial median CPU before | Initial median CPU after |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Receipt | 80,043 | 2 | 12.07 MB | 2.10 MB | 16.16 ms | 4.13 ms |
| Panel | 290,049 | 2 | 27.19 MB | 4.19 MB | 40.40 ms | 7.09 ms |

These fixed-timestamp serializer fixtures compare identical complete JSON. Timestamp insertion took about 0.55 microseconds for the receipt and 0.13 milliseconds for the panel. Bulk encoding runs outside the log lock.

## Query investigation

Live trials used reviewed synthetic output and a bounded proxy. The installed key stayed in proxy memory. Each run had call and usage-token limits. Production wording remains unchanged. Request serialization changes preserve the existing payload and do not claim a token reduction.

| Candidate | Finding | Decision |
| --- | --- | --- |
| Remove the probability-estimation sentence | Base and precision checks kept required labels. An independent holdout kept more OpenAI routine noise; TypeSafe savings did not improve consistently. | Retain the sentence. |
| Move the rubric into shared state | Reduced input tokens but kept substantially more routine lines and saved fewer bytes. | Retain per-question criteria. |
| Shorten structured criteria | OpenAI lost required temporal evidence. TypeSafe kept reviewed labels in one split, with a small gain that lacks independent confirmation. | Retain established criteria. |
| Refer to the target through an explicit JSON array path | OpenAI returned six refusals. TypeSafe lost required transition evidence. | Retain the source-line reference. |

The complete 18-case controls use the first successful result, then bounded tail or retry results for failed cases. Failed attempts remain recorded separately. OpenAI controls saved 59,306 bytes and kept 159 labelled routine lines. Their shared-rubric variant saved 55,116 bytes and kept 228. TypeSafe controls saved 57,534 bytes and kept 231 routine lines. Their shared-rubric variant saved 35,517 bytes and kept 764.

The OpenAI control proposed omitting seven required lines in a preview-only case; the complete result remained visible. Its shared-rubric variant proposed omitting 19. These live model judgments are distinct from the zero-loss offline protocol corpus. The fixtures do not establish universal model accuracy.

The existing questions follow the [OpenAI Decisions contract](https://developers.openai.com/api/reference/typescript/resources/decisions/methods/create) and [TypeSafe Noul guidance](https://docs.typesafe.ai/primitives/noul). Each candidate line receives one probability of task relevance. The [TypeSafe model guidance](https://docs.typesafe.ai/model-jaggedness/jev-1.13) supports explicit references, aligned criteria, and limited irrelevant context.

## Validation checkpoints

| Check | Result |
| --- | --- |
| Rust and lint | Latest full checkpoint: 143 Rust tests and Clippy passed. The reviewed candidate also passed independently in the Lab with Rust 1.97.1; host checks use Rust 1.95.0. |
| Complete offline corpus | 312 cases across five splits for each provider. All 5,124 required labels retained, with zero actual or proposed loss and matching saved-output totals. This frozen checkpoint follows the direct panel and timestamp changes. |
| Node and Python | Linux Node: 68 passed, one optional WSL check skipped. Native Windows Node: 65 passed, four platform or optional skips. Four Python checks passed. |
| Native consumers | The revised renderer passed Edge smoke at four widths. Before row reuse, the isolated VS Code panel passed CSP loading, reloads, hide/reopen, session changes, version-6 protected rows, and empty activity. The revised renderer's VS Code rerun is pending because VS Code's updater holds the launch lock. |
| Concurrent faults | Fresh frozen checks passed 96 invocations across both providers: 72 replacements, 24 deliberate failures, zero deadlines. They verified exact readable and typed originals, stats, completed panels, and the managed-log limit. |
| Process interruption | Kill the real hook after its first relevance snapshot. Both providers publish no completed replacement, receipt, stats, or saved original. A later invocation completes with exact originals, retained diagnostics, and a valid panel. |
| CI fault checks | The short mixed-fault runs passed 48 invocations: 36 replacements and 12 deliberate failures. CI now runs these checks and interruption recovery for both providers. |

Protocol faults cover HTTP errors, malformed JSON, oversized bodies, invalid probabilities, provider/model mismatches, and timeouts. The real-process runners use loopback mocks, shared private sessions, bounded temporary fixtures, and response jitter. They remove only verified disposable originals after each group and stop owned children before fixture cleanup.

A later Chromium endurance check rotates actual synthetic hook snapshots with 242 and 10,000 rows. Sending each complete snapshot through the debugger exhausted a 3 GiB Lab container with both renderers. Loading fixtures once and cloning fresh messages inside the page reduced driver overhead; the original renderer then passed 100 updates. In a paired preliminary run, row reuse reduced the maximum sampled DOM count from 1,163,625 to 143,492 and the panel render 95th percentile from 2.405 to 2.022 seconds. Maximum sampled container memory fell from 2.62 to 2.38 GB. These are one-CPU measurements, not general latency guarantees. The revised renderer passed the complete Chromium suite and native Edge. The quality runner now supports `--resident-panels` for large-snapshot endurance and records the transport and DOM counts.

The revised renderer passed 60 minutes with 1,638 fresh page-generated messages, 81 completed-animation checks, and 163 toolbar fallback checks. It used one CPU and 3 GiB, with no panel reloads or forced garbage collection. All 242- and 10,000-row snapshots remained intact, with zero page errors. Maximum sampled container memory was 2.55 GB and maximum sampled DOM count was 141,788. Panel rendering had a 2.283-second 95th percentile on this constrained system. The full-debugger-payload failures remain separate evidence; this pass does not prove that transport can sustain the same load. The earlier native consumer checks do not establish endurance at this size.

A renderer-free diagnostic sent 200 complete snapshots through the same debugger mechanism. It completed without forced garbage collection, but its sampled JavaScript heap grew from 58 MB at ten messages to 868 MB at 200 messages, with seven DOM nodes. Sampled container memory reached 1.46 GB. This isolates a substantial driver contribution; it does not attribute every allocation in the failed full-renderer runs. The exact short resident-panel CI command also passed, rotating historical and current protected rows with two reloads, four animation checks, and two fallback checks.

Two frozen 45-minute runs passed 14,144 invocations: 10,608 replacements, 3,536 deliberate failures, 412,373 mock requests, and more than 2.16 GB of synthetic source. These runs precede the later timestamp and direct panel encoders.

The optimized one-CPU TypeSafe run completed 30 minutes with eight concurrent hooks and six protocol or timeout faults. It passed 5,368 invocations, 4,026 replacements, 1,342 deliberate failures, 200,870 mock requests, and 1.08 GB of source. There were no deadline fallbacks. The 10,000-line success median was 6.013 seconds and its 95th percentile was 6.836 seconds.

A debug run with eight processes on one Lab CPU reached the existing 45-second limit. Its deadline check verified six safe fallbacks, twelve replacements, and six deliberate failures, preserving full results and previous completed panels. An optimized verification build then passed 96 invocations without a deadline fallback. Verification builds enable assertions and the loopback endpoint; they must not be packaged for release.

Lab-Control supplied independent Linux checks and Chromium after an initial capacity delay. Production hosts were not used for compilation. The release hook declares glibc versions through 2.34; the controller declares versions through 2.39, including weak PID-file-descriptor spawn references. Both maxima match the baseline packages. The Lab and installed WSL runtime use glibc 2.39. Compatibility with older controller runtimes is not established by these checks. The one-hour OpenAI pressure run passed 10,128 invocations: 7,596 replacements, 2,532 deliberate failures, 402,390 mock requests, and 2.06 GB of synthetic source. There were no deadline fallbacks. With eight processes on one CPU, the 10,000-line success median was 6.323 seconds and its 95th percentile was 7.284 seconds.

At the 17:06 Berlin deployment preflight, the release archives matched the current source, with nine plugin files and nineteen control files. The registered plugin source and installed cache matched the preserved 0.11.0 archive. The seven installed composer files matched their rollback metadata, and all five rollback file hashes were recorded. Release verification checks CI, installed versions and bytes, hook trust, an eligible installed hook call, and published asset hashes. Keep the old archive and composer rollback files.
