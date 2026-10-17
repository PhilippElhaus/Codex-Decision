# Usage and integration audit, 2026-10-17

About 7.34–7.78% of enabled hook invocations in the exact accounting cohort reached an API evaluation. The concern about a rate below 10% is supported. Small outputs and exact source reads account for about 62% of invocations. The inspected evidence supports integration repairs and better measurement. It does not support weaker privacy guards or a higher omission cutoff.

## Scope

The read-only observation ran from 09:05:42 to 09:05:53 Europe/Berlin on October 17, 2026. It used the installed data directory configured by the Windows VS Code control. It found 58 session scopes, including 52 with hook health. Twenty-three scopes had exact health counters. The retired data copy was excluded. Active use continued during the observation.

The [audit script](../../scripts/usage_effectiveness_audit.cjs) reads publication-aware activity, bounded event summaries, saved-original references, and matching rollout records. It exports counts and allowlisted categories. It does not open credentials, make a provider request, export private tool text, or change runtime state. The [previous audit](usage_effectiveness_2026-10-16.md) describes the underlying retention and delivery limits.

Reproduce this observation with the directories reported by the actual installation:

```sh
node scripts/usage_effectiveness_audit.cjs \
  --data-dir /absolute/installed/plugin-data \
  --codex-sessions /absolute/codex/sessions \
  --observation-date 2026-10-17 \
  --since 2026-10-16T00:00:00Z
```

The recent slice includes retained events dated at or after the supplied UTC boundary. Lifetime counters remain lifetime counters. A hook version in the latest health record does not identify the version that produced every historical count in that scope.

## What the rate measures

| Exact-cohort measure | Count |
| --- | ---: |
| Enabled hook invocations | 21,695 |
| Skipped outputs, including classification keeps | 21,187 |
| Completed line evaluations | 489 |
| Hook errors | 19 |
| API request attempts | 1,688 |
| Cancelled intents before sending | 0 |
| Classification keeps after a validated API answer | 1,103 |
| Outputs confirmed to have reached an API evaluation | At least 1,592 |
| Outputs that could have reached an API evaluation | At most 1,688 |

The invocation outcomes reconcile: 21,187 skips + 489 completed evaluations + 19 errors = 21,695 invocations. A classification keep belongs to the skip count even though the provider already evaluated the output. Subtracting all skips therefore undercounts outputs that reached the API.

The lower bound adds completed line evaluations and classification keeps. The upper bound uses request attempts after excluding cancelled intents and the invocations left after definite pre-API skips. An attempt can fail during DNS, TLS, or connection setup before the provider receives the output. One output can use a classification request, several relevance requests, and fallback requests. Request attempts cannot identify an exact count of distinct evaluated outputs. The observed bounds are 7.3381–7.7806%. The request rate is 7.7806 attempts per 100 invocations.

The script now exports this funnel only when its required counters and skip-reason coverage are exact. It suppresses the bounds when invocation outcomes do not reconcile. Missing historical counts remain unknown.

## Why outputs skip

| Exact-cohort skip reason | Count | Stage |
| --- | ---: | --- |
| Small output | 8,442 | Before API |
| Exact source or diff content | 4,981 | Before API |
| Unsupported result envelope | 2,175 | Before API |
| Unsupported tool route | 1,260 | Before API |
| Classification kept full output | 1,103 | After API |
| Structure guard | 1,089 | Before API |
| No eligible lines | 985 | Before or after classification |
| Sensitive output, command, or input | 423 | Before API |
| Generic MCP replacement disabled | 416 | Before API in Filter mode |
| Insufficient possible savings | 289 | Before API |
| Unsafe task context | 18 | Before API |
| Tool-input budget | 6 | Before API |

At least 19,099 invocations, about 88.0%, skipped before a provider request. The default minimum is already 256 UTF-8 bytes. Smaller output has little room for useful reduction after the omission header and original reference. Exact source and diff reads retain coupled evidence. Sensitive and unknown-envelope guards preserve the existing privacy and evidence boundaries.

Unsupported routes and results account for 3,435 invocations, about 15.8%. They are useful integration investigation targets. Their recent health counters do not retain per-output tool and schema metadata. The audit cannot assign those skips to a particular wrapper or MCP schema from these counters. Unknown schemas need a validated projection and preservation tests before they can be accepted.

## Recent decisions

Since October 16 at 00:00 UTC, retained events contain 235 classification keeps and 73 completed line evaluations: 60 replacements, 12 previews, and one result with no omissions. These are retained outcomes with mixed normal and verification traffic. They do not provide a recent-window invocation denominator.

The classification-only histogram contains:

| Selected output class for a classification keep | Count |
| --- | ---: |
| Mixed or unknown | 147 |
| Prose | 53 |
| Repetitive log | 19 |
| Independent matches | 5 |
| Progress output | 4 |
| Independent records | 3 |
| Exact content | 3 |
| Structured payload | 1 |

Mixed or unknown content and prose account for 200 of the 235 keeps, about 85.1%. Thirty-one selected an excerptable class but failed the existing combined-confidence requirement. The records do not justify lowering that requirement. The classification-only tool categories are 203 shell results and 32 web results. All 73 recent completed line evaluations name `Bash`.

The audit previously returned before adding request timing and API usage from classification-only skip events. That omitted recorded provider work from the audit totals. The corrected reader includes it. Across retained history, 2,450 usage-bearing events report 9,160,148 input tokens and 73,632 output tokens. These are retained reported usage, with historical gaps. They are not billed-token savings or an all-history invoice total. The corrected totals must not be compared with the previous script's totals as if the difference were new traffic.

## Evidence preservation and delivery

The audit reviewed 476 published replacement receipts. Their original and visible payloads contain 2,045,247 and 861,011 UTF-8 bytes respectively. All 471 current-format original references resolve to saved files with exactly matching bytes. Five legacy receipts lack the current reference format. There are no missing or mismatched current-format originals. At least 71 receipts contain an explicit synthetic, dummy, or fixture marker.

The receipt tools are 473 `Bash` results, two native Lab execute results, and one `exec_command` result. The matching rollout observation covers 49 session scopes and 16,640 unique tool-result items. Normal calls predominantly use code-mode `exec` and `wait`. No complete rendered Decision or Jev omission header appears in those result items.

A replacement receipt establishes the hook's prepared payload and preserved original. It does not acknowledge delivery to the model. Missing rollout headers do not establish that separate hook feedback was absent. This observation leaves normal-session context reduction unverified. Integration validation must inspect the actual host result boundary and the focused thread's hook activity before making a delivered-savings claim.

## Changes justified by this audit

- Repair host integration and thread-state discrepancies through supported, verified host patches. Preserve a diagnostic for unsupported host builds.
- Keep request attempts, classification keeps, line evaluations, previews, and replacements separate in measurements.
- Include classification-only API work in audit usage and timing totals.
- Report bounds for distinct outputs reaching API evaluation. Preserve unknown historical coverage.
- Use an explicit recent retained-event boundary and sanitized class, tool-family, and size histograms for follow-up investigations.
- Use isolated data directories and session identifiers for verification. Keep actual host delivery evidence separate from direct hook tests.

The audit changes preserve runtime settings, provider selection, credentials, classification confidence, relevance cutoff, and omission guards. `node --test tests/unit/usage_effectiveness_audit.test.cjs` passes nine focused tests. They cover API-output bounds, cancellation, incomplete coverage, inconsistent snapshots and skip maps, classification-only usage, recent-event boundaries and truncated tails, private metadata redaction, and publication retries. `node scripts/usage_effectiveness_audit.cjs --self-test` passes ten checks.
