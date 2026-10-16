# Usage and effectiveness audit, 2026-10-16

The records show that Decision can reduce a hook payload and preserve its original evidence. They do not establish that normal Codex sessions received less model context or produced better answers. Synthetic verification and ordinary session activity share the same records. Delivery and task outcomes are the main measurement gaps.

## Scope and method

The measured snapshot covers 18:39:38–18:39:48 Europe/Berlin on October 16, 2026, before the provider-fallback release. Active use continued during the read. Counts can therefore change in a later run. The audit used the data directory configured by the installed VS Code control. It did not assume a plugin path from a different window. The retired plugin-data copy was excluded to avoid counting migrated records twice. The configured directory contained 56 session scopes: 50 had hook health and six had no recorded activity. Retained event dates span September 29 through October 16. The oldest last-observed session health date was September 30.

The read-only [audit script](../../scripts/usage_effectiveness_audit.cjs) uses the same validated, publication-aware activity reader as the control. Each metric reports its recorded sum, known scopes, partial scopes, and unknown scopes. It keeps the legacy installation scope separate from per-session data. Missing counters do not become zero. A publication retry contributes only its accepted snapshot.

The script reads bounded event summaries, inventories original files, and compares published replacement receipts with their saved originals. It reads private tool text only in memory for that comparison and a coarse explicit-fixture check. It never opens `.env`, sends a request, changes runtime state, or exports a task, output excerpt, session ID, source hash, private path, or arbitrary unknown identifier. It exports only counts and allowlisted categories.

For downstream observations, the script matches rollout filenames to session hashes. It uses the owning filename because forked history can retain parent `session_meta` records. It deduplicates repeated session/call/output records. It rejects linked input roots, skips linked descendants, and bounds each record to 20 MiB before decoding. It scans tool-result items for a complete rendered omission header. It does not scan private user messages for a task-success judgment.

Reproduce the audit with the actual installed data directory and local rollout directory:

```sh
node scripts/usage_effectiveness_audit.cjs \
  --data-dir /absolute/installed/plugin-data \
  --codex-sessions /absolute/codex/sessions \
  --observation-date 2026-10-16
```

The command prints sanitized JSON. Paths in this example are placeholders. The script makes no live provider call.

For post-release observations, `fallback_completed_outcomes` and `fallback_completed_replacements` distinguish explicit fallback use, explicit non-use, and unknown historical metadata. They cover completed `keep`, `candidate`, and `replace` line-evaluation events. The script also groups completed fallback outcomes by actual and configured provider. Missing old `fallback_used` fields remain unknown; they never become false. These fields measure completed fallback outcomes only. They do not attribute failed attempts to a provider, count classification-only fallback outcomes, or establish downstream delivery. The pre-release snapshot below is unchanged.

## Request and reduction evidence

Twenty-one session scopes had exact scheme-1 health counters and exact counters for the metrics below. They form the most useful accounting cohort. They still contain synthetic verification.

| Recorded measure | Exact cohort |
| --- | ---: |
| Enabled hook invocations | 18,325 |
| Locally skipped results | 17,891 |
| API request attempts | 1,413 |
| HTTP responses received | 1,406 |
| Validated API answers | 1,399 |
| Request failures | 14 |
| Cancelled request intents | 0 |
| Committed line evaluations | 420 |
| Hook replacements | 314 |
| Candidate previews | 100 |
| Evaluations with no omissions | 6 |
| Source lines in committed evaluations | 17,438 |
| Relevance-judged lines | 15,194 |
| Proposed omitted lines | 10,852 |
| Omitted lines in hook replacements | 10,228 |
| Recorded hook character reduction | 866,725 |

The request outcomes reconcile: 1,399 validated answers plus 14 failures equal 1,413 attempts. Seven failures received an HTTP response; seven did not. The validated-answer rate was about 99.0%. A validated answer can be a classification that keeps all output. It is not a completed line evaluation or a replacement.

About 1.7% of this cohort's invocations recorded a replacement. This is a hook activity ratio, not a normal-use success rate. About 97.6% skipped locally. Small, exact, sensitive, and unsupported inputs account for much of that traffic. Increasing replacement counts by relaxing these rules would not establish better task results.

The cohort recorded 666,106 ms across 1,399 timed results, about 476 ms per timed result. This is recorded evaluation timing. It does not include every failed request or establish total user-visible tool delay.

The wider history records 779 completed evaluations and 465 replacements across the legacy installation scope and session scopes. It has incomplete legacy coverage and mixed counter definitions. Do not calculate an all-history conversion rate or error rate from those totals. Summed historical skip counts can exceed summed invocation counts because their coverage differs.

Retained event summaries include 6,354,263 input tokens and 32,966 output tokens in 620 usage-bearing records. These are reported provider usage for retained outcomes. They omit unrecorded or failed activity and are not billed Codex savings. Provider identity is absent in 140 retained outcome summaries; 582 explicitly identify OpenAI. The audit cannot make a reliable historical OpenAI-versus-TypeSafe quality or cost comparison.

## Evidence retention and downstream delivery

The audit found 420 published replacement receipts with readable source and replacement payloads. They contain 1,820,779 original UTF-8 bytes and 787,501 replacement bytes, a difference of 1,033,278 bytes at the hook boundary. This is an observed payload reduction, not a billed-token or task-quality estimate.

Of these receipts, 415 used the current original-reference format. Every one referenced an existing saved original with exactly matching bytes. There were zero missing or mismatched originals. Five older receipts lacked that reference format and were not verified through the current reference parser. The original inventory contains 465 readable files and six typed-envelope files. Originals do not follow automatic log retention.

At least 65 replacement receipts contain explicit `synthetic`, `dummy`, or `fixture` text. This is a conservative fixture marker, not a classifier for the remaining records. Of the 420 receipts, 417 name `Bash`, two name native Lab execute, and one names `exec_command`. Normal rollout tool calls in the matched sessions use code-mode `exec`/`wait` and session-control tools. The receipt totals therefore cannot represent unambiguously ordinary production traffic. Using a real session ID for direct hook verification does not make that verification an ordinary tool call.

Forty-seven actual rollout scopes matched the 56 plugin scopes. Their files contained 15,368 unique tool-result items and zero complete rendered Decision or Jev omission headers. Nine plugin scopes had no matching rollout. No malformed, oversized, or incomplete rollout records were encountered in this observation.

The absence of a header does not prove that no hook feedback reached a model. Rollout storage may omit separate hook feedback, and the code-mode wrapper can still expose its original return value. The existing [request reliability audit](reliability_audit_2026-10-08.md) documents this boundary. A saved receipt proves the hook's decision and original, not downstream delivery. No delivery acknowledgement or counterfactual task-outcome label exists in the inspected records.

The defensible usefulness assessment is therefore:

- **Evidence preservation:** directly supported for all 415 current-format references reviewed.
- **Reduction on reviewed examples:** directly supported at the hook boundary, with substantial synthetic activity.
- **Normal-session context reduction:** unverified in the observed rollouts.
- **Answer correctness, less missed evidence, and fewer repeated investigations:** not measured. Historical synthetic holdouts are useful regression evidence; they cannot establish these outcomes for ordinary sessions.

## Low-cost improvements, ranked by effect on usefulness

| Priority | Change and acceptance evidence | Disposition |
| --- | --- | --- |
| 1 | State the observed boundary in composer, Totals, and installation totals. Use hook-payload estimates and an explicit unverified-delivery status. Keep request, preview, replacement, and outcome counts separate. | Included in this release's control work. The audit supplies a repeatable observation command. This improves the user's decisions about when to trust the tool. |
| 2 | Keep both provider keys and permit explicit switching and opt-in fallback. Keep the full original on failure. Record configured and actual providers, fallback use, and durable request outcomes. Test failure, malformed answer, later-batch failure, and deadline behavior. | Included in this release's provider work. Fourteen confirmed request failures support the reliability need. The audit does not claim that all would have recovered through another provider. |
| 3 | Check original availability before relying on omitted evidence. Use the exact result-specific path and confirm source ranges needed for the answer. Re-run the sanitized original-reference check after a migration. | The audit now validates current-format saved originals. Existing skill instructions already require exact-original review when an answer depends on omitted lines. No retention or omission guard change is justified. |
| 4 | Separate verification traffic from ordinary usage with isolated plugin-data directories and distinct test session IDs. Measure a reviewed normal-task cohort separately. Require a delivered-result check and required-evidence labels before claiming effectiveness gains. | Necessary for the next effectiveness comparison. Existing mixed history cannot be relabelled reliably. A heuristic fixture marker must not rewrite historical production counters. |
| 5 | Record or inspect task-cue provenance when judgments appear unrelated. Review short follow-up cues and the latest safe task before expanding context. Use a reviewed holdout with required facts and final-answer checks. | Follow-up investigation. There is only one recorded missing-task candidate; the records do not establish a broad task-context defect. Sending more context or using an older task needs separate evidence and privacy review. |

Large skip categories do not identify defects by themselves. Session skip records include at least 10,255 small outputs, 5,000 exact reads, 3,416 unsupported results, 1,731 unsupported routes, 1,210 classification keeps, and 1,187 structure guards. These are partial-history category totals. The audit supplies no reviewed examples that justify accepting unknown envelopes, weakening sensitive-text checks, lowering the classification gate, or raising the relevance cutoff. Those changes would need evidence-retention tests and task-quality review first.

The highest-impact remaining integration work is a trustworthy acknowledgement at the actual model-context boundary. That boundary belongs partly to the Codex host. A plugin cannot infer it from a successful receipt, a green API probe, a saved original, or an omission count.

## Validation

`node --test tests/unit/usage_effectiveness_audit.test.cjs` passes six focused tests. They cover exact and migrated coverage, current original verification, exclusion of unpublished and duplicate receipts, arbitrary-string redaction, malformed counters, publication retries, duplicate rollouts, inherited records, forked metadata, real versus quoted headers, bounded oversized records, incomplete tails, and linked paths. `node scripts/usage_effectiveness_audit.cjs --self-test` also passes. The installed-state audit made no provider request and changed no credentials, settings, counters, or logs.
