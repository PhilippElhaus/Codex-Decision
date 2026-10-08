# Processing recovery — 8 October 2026

Plugin 0.11.4 and control 0.10.9 recover validated command logs, improve skip attribution, and remove the empty explanatory sections from Totals. A restored chat also stays selected when focus remains in Terminal.

## Skip audit

The screenshot reports cumulative history. A later metadata-only snapshot had 498 observed outputs, 487 skips, and 36 API attempts. The unsafe-task count remained 40 as new outputs arrived. Historical totals are preserved. Aggregate counters cannot identify which old protected records contained actual credentials; protected payloads were not opened.

| Screenshot reason | Outputs | Finding and change |
| --- | ---: | --- |
| Protected text or input | 122 | Exact source reads now stop under their source reason before task or privacy checks. Precise read-only environment references no longer trigger named-marker protection. Input checks use original string values while retaining credential-field and path guards. New bounded codes distinguish protected output, command, and other input. |
| Short output | 80 | The default minimum is 256 bytes. A replacement must save more than 256 bytes after original-file links and protected evidence. These outputs cannot produce a valid replacement. The threshold stays unchanged. |
| Response format kept full | 79 | Known Lab-Control results duplicate stdout/stderr in JSON text and structured content. The adapter validates exact schemas and equality, preserves status/cursor fields and all stderr, and saves the typed original. Unknown fields, media, mismatches, truncated streams, and ambiguous tail responses stay complete. |
| Exact source content | 42 | Source and diffs remain complete. Dotted tool namespaces now receive the same exact-source and mutation guards as their underlying action. |
| Task context unavailable | 40 | This historical count did not grow during the audit. The earlier screenshot repair is active. Local format and no-eligible-line checks now precede transcript reads, avoiding work and misleading attribution for outputs already required to stay complete. |
| Tool format kept full | 39 | Empty `write_stdin` calls are output polling. They now qualify with an empty input and a validated command-result shape. Actual writes and mutation acknowledgements remain complete. |
| Classified and kept full | 19 | A provider request ran but failed the 95% excerptability gate. Live dummy runs confirm conservative classification keeps. The gate and 5% line cutoff stay unchanged. |

The user explicitly enabled shortening for validated Lab-Control logs. Exact execute/wait envelopes with a locally validated independent-line format now use the supported command contract under the main Decision toggle and mode. The saved generic MCP replacement flag remains unchanged; it still applies to other MCP results. Unknown or coupled native Lab output stays complete, and Monitor records previews. Validated serialized Lab results in supported `exec`/`wait` envelopes also use the command contract. No installed provider or cutoff is changed by this release.

## Test improvements

The runner reconciles proxy calls with persisted attempts, classification and relevance stages, receipts, error counts, and completion statistics. Eligible offline cases cannot silently skip and pass. Fault cases can be selected by ID. Unexpected live errors or proxy bypass stop the run after saving evidence. A preflight rejects production binaries before loading a key or sending requests. Forwarded and completed API requests are separate metrics.

The matrix runner covers every corpus split for both providers with bounded parallelism. Each fault suite runs once per provider. A new output directory prevents stale reports from hiding failures. CI now includes both providers' holdout, batching, and precision splits.

The optimized `verification` profile retains assertions and the loopback endpoint. Large unoptimized debug pressure runs can hit the existing 45-second limit on one CPU. Production packages build a separate release profile with the test endpoint disabled; deadlines stay unchanged.

Host and native checks cover home-first startup, unfocused restored chats, stable host identity across renderer reloads, visibility transfer, deliberate home navigation, and background-view isolation. Totals retains populated reason tables and omits empty headings and prose.

## Evidence and limits

The initial matrix passed 316 cases with 719 mock requests and no required-line loss. Initial live OpenAI runs covered 31 base and 18 precision holdout cases. They made 30 and 37 matching proxy/health requests, produced 15 and 16 replacements, and lost no required lines in delivered results. Conservative classification keeps stayed complete. Some proposed omissions included required lines in previews; those were not actual removals.

The current recovery build passed eleven additional live cases with eight matching proxy/health requests, six replacements, one Monitor preview, and four intentional local skips. It preserved every required line. The recovered paths include output polling, precise environment references, wrapped Lab logs, and complete traceback output.

The authorized native Lab checks filtered execute and wait results while the generic MCP flag remained false. One alias request exceeded the fixture's four-second deadline; its late response was HTTP 200. The failed invocation kept full output and counted the attempt. A focused retry passed, including the disabled, plain-string, prose, mismatched, mixed-media, and truncated negatives. No timeout or relevance setting was relaxed.

Final validation passed 167 Rust tests, Clippy, 79 Node tests with one optional Windows test skipped on Linux, four Python checks, Chromium, native Edge, 13 native VS Code checks, and 100 repeated browser layout rounds. The final matrix passed 360 cases with 738 matching mock requests and no required-line loss. Optimized pressure checks passed 256 invocations, including 64 deliberate failures, with 7,642 mock requests and no deadline fallback. Both providers passed interruption and retry checks. The 128-invocation OpenAI debug run took about 403 seconds; its optimized verification counterpart took about 52 seconds. This compares test builds, not production performance.

The first live setup incorrectly used a production binary, which ignores the loopback override. Its synthetic fixture key was rejected, and the proxy forwarded no installed credential. Those results are excluded from quality measurements and motivated the new preflight and counter checks.

Final synthetic records are retained in ignored `.local/quality/dummy-20261008/`. Public evidence contains no real credential or private chat. The documented code-mode limitation remains: a receipt proves the hook's decision and saved original, while a wrapper can still expose its original JavaScript return value. Receipt counters alone do not establish end-to-end token savings.
