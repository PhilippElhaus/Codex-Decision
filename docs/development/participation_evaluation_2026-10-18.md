# Output participation investigation, 2026-10-18

About **8.04–8.44%** of enabled hook invocations reached an API evaluation in
the current exact-counter cohort. Only **2.12%** completed line relevance.
The main opportunity is better support for known result formats and fewer
false local protections. Increasing the omission cutoff cannot change an
output that skips before the API.

This is the initial observation and baseline with installed version 0.12.1.
The subsequent [0.13.0 implementation and validation](coverage_release_0.13.0.md)
records the fixes and the paired results.

## Installed observation

The read-only audit ran from 21:04:08 to 21:04:14 Europe/Berlin on October 18,
2026. The Windows VS Code setting identified the installed data directory.
The current thread ID identified its session scope. Hook trust was enabled.
No credential was inspected or exported. The audit made no provider request.

The installation contained 63 session scopes, 57 with hook health. Twenty-eight
scopes had exact accounting. These are lifetime counters in those scopes,
including retained verification activity. They are not a representative random
sample or a recent-window rate. Active use continued during the observation.

| Exact-cohort outcome | Count | Share of enabled invocations |
| --- | ---: | ---: |
| Enabled invocations | 40,021 | 100% |
| API-evaluated outputs, lower bound | 3,216 | 8.04% |
| API-evaluated outputs, upper bound | 3,377 | 8.44% |
| Completed line evaluations | 850 | 2.12% |
| Classification keeps after an API answer | 2,366 | 5.91% |
| Hook errors | 33 | 0.08% |
| API request attempts | 3,377 | 8.44 attempts per 100 invocations |

The outcomes reconcile: 39,138 skips + 850 completed evaluations + 33 errors =
40,021. A classification keep is a skip even though the API evaluated it. One
output can make several requests. Request attempts and skipped outputs do not
form disjoint output counts. The screenshots therefore cannot establish an
exact participation rate.

| Local skip reason | Count | Share of enabled invocations |
| --- | ---: | ---: |
| Below configured minimum (default: 256 UTF-8 bytes) | 15,451 | 38.61% |
| Exact source or diff content | 8,890 | 22.21% |
| Unsupported result envelope | 3,717 | 9.29% |
| Unsupported tool route | 2,684 | 6.71% |
| Structure guard | 2,141 | 5.35% |
| No eligible lines | 1,838 | 4.59% |
| Sensitive output, command, or input | 871 | 2.18% |
| Generic MCP replacement disabled | 646 | 1.61% |
| Insufficient possible savings | 494 | 1.23% |
| Unsafe task context | 23 | 0.06% |
| Tool-input budget | 17 | 0.04% |

Small outputs and exact reads account for 60.82% of invocations. Sending these
to a provider to increase a counter would add cost with little useful reduction
or would expose coupled source evidence to line removal. The 6,401 unsupported
routes and envelopes are a 16.0 percentage-point investigation ceiling. Their
tool names and schemas were not retained per skip. This is not a measured
recoverable gain.

The recent retained-event slice starts at October 17, 00:00 UTC. It contains
1,307 classification keeps, including 253 whose selected class was excerptable.
An excerptable selection can still fail the combined 95% probability gate.
These 253 events are candidates for classifier calibration, not proof that the
gate should accept them. The slice has no complete invocation denominator.

## Code findings and matched tests

The hook checks route, envelope, size, source format, privacy, line protection,
MCP policy, task context, and possible savings before requesting a judgment.
See [the pipeline](../../rust/decision/src/bin/decision-hook/pipeline.rs).

The new synthetic coverage split includes the same useful log through shell,
code-mode, and MCP results. It also includes matched safe and unsafe gate cases:

- The route guard rejects mutation words anywhere in a tool action. A read-only
  name such as `list_commits` can fail before the read-only prefix is checked.
- A generic MCP `structuredContent` field prevents projection. The pinned
  Lab-Control adapter is an explicit exception. A serialized batch of command
  results also lacks a projection contract.
- Diagnostic protection matches substrings such as `error` and `failed`.
  Routine counters and passing test names can leave no eligible lines. Real
  diagnostics must remain protected when this rule changes.
- Scalar-looking path names can trigger the JSON structure guard. Explicit log
  read recognition accepts `.log`, while uppercase and rotated names stay exact.

These fixtures establish reproducible misses. They do not establish their
frequency in private workload history.

## Evaluation contract

Every corpus invocation now enters the coverage report, including outputs that
produce no receipt. Disabled controls and deliberately injected faults are
reported separately from normal enabled outputs. An unexpected provider error
stays in the normal denominator.

The report distinguishes distinct outputs with a request, request attempts,
validated classifications, completed relevance decisions, classification keeps,
previews, and prepared replacements. It groups output counts and UTF-8 source
bytes by tool family, size band, and skip reason. It also reports coverage of
explicitly labeled safe opportunities. Unlabeled cases remain unknown.
Byte-weighted participation counts the whole source size of each selected
output. It does not measure transmitted bytes: classification samples source,
and relevance batches can repeat context.

Byte accounting uses the exact projected source for adapters and metadata.
The previous runner compared raw stdout with a replacement of the projected
source. That could misstate savings. A preview has zero prepared reduction.
Prepared reduction remains separate from model-visible delivery, which this
process-level runner cannot verify.

Required-line losses are reported for proposed and prepared omissions. Required
labels in full-kept outputs must not inflate the evidence for omission safety.
The report identifies labels exposed to completed decisions and to actual
model judgments. Offline provider replies follow the fixture labels. Offline
results measure routing and application behavior, not classifier accuracy.

Before changing a runtime gate, compare the current hook and candidate hook on
the same frozen coverage inputs, evidence labels, and safety requirements, both
provider wire formats, and the existing
fault suites. Use the old corpora for development and keep a new independent
holdout for the final live comparison. A useful acceptance target is at least
90% API coverage of reviewed safe opportunities, with zero sensitive sends,
zero required-line losses, exact originals, and complete rollback on failures.
This target applies to the labeled corpus; it is not a promised workload rate.
Review candidate request expectations separately: current regression fixtures
explicitly expect the baseline misses. A repaired route requires an updated
request expectation, while its input and required evidence stay fixed.

Then run bounded live checks with reviewed synthetic data. Compare whole-output
API coverage and line-stage coverage, routine lines retained, evidence loss,
latency, request count, and provider usage. Keep the 5% omission cutoff and 95%
classification gate fixed while testing format recognition. Inspect the real
host result boundary separately before claiming delivered context reduction.

## Measured coverage baseline

The frozen synthetic split contains 33 cases: 32 enabled outputs and one
disabled control. Both offline provider wire formats and the live OpenAI run
gave the same routing outcomes:

| Measure | Result |
| --- | ---: |
| Enabled outputs reaching evaluation | 10 / 32 (31.25%) |
| Completed line evaluations | 9 / 32 (28.13%) |
| Reviewed safe opportunities evaluated | 9 / 20 (45%) |
| Reviewed safe opportunities missed | 11 / 20 |
| Local-only controls sent to API | 0 / 11 |
| Required labels in prepared replacements | 21 |
| Required labels actually model-judged | 5 |
| Required labels protected before judgment | 16 |
| Proposed or prepared required-line losses | 0 |
| Saved originals verified | 9 / 9 |

The 11 misses consist of two result-envelope/batch cases, two diagnostic-word
cases, three read-only route names, two scalar filenames, and two log suffixes.
These are concrete targets for runtime changes. A zero-loss result on five
model-judged required facts does not establish a general omission error rate.

The live run used `gpt-6-luna`, the configured OpenAI provider, and the current
5% cutoff. Only synthetic fixture text reached the provider. The first pass
crossed its 100,000 reported-token admission budget after six completed
requests. The proxy rejected the next request before forwarding it. A separate
bounded pass completed the remaining cases without repeating completed calls.
Reports retain that extra budget-control invocation separately: 34 total hook
invocations, 33 final corpus outcomes, 11 proxy arrivals, and 10 provider
requests. The budget control kept full output and lost no required line.

The provider reported 171,163 input tokens and zero output tokens across the
ten requests. The nine prepared replacements reduced projected text by 17,382
UTF-8 bytes. Median and p95 hook time among called corpus outputs were 809 ms
and 1,245 ms. These are observed process results, not delivered context savings
or evidence of net cost savings.

The local artifacts are in the ignored
`.local/quality/participation-investigation/` directory. `audit.json` records the
installed observation. `matrix/` contains the offline provider runs.
`live-coverage/` and `live-coverage-completion/` preserve both live passes.
`live-combined.json` separates the completed corpus from the extra budget
control. No installed settings or runtime guards changed.

Reproduce the offline coverage baseline with:

```sh
node scripts/two_stage_quality.cjs --coverage --skip-faults \
  --out .local/quality/coverage-baseline
```

The regular dummy matrix now includes this split for both providers, so CI
continues to check it. For a bounded live check, add `--live`, the installed
`--data-dir`, `--provider openai`, `--max-calls 20`, and `--max-tokens 250000`.
The token admission check uses usage returned by completed calls; a final call
can cross that threshold before the next call is refused.

## Validation and limits

The Rust suite passed 272 tests with one ignored. The Node suite passed 165
tests with three platform skips. All 16 Python checks passed. The new coverage
split passed all 33 cases for each offline provider and the completed live
corpus. It is included in the regular six-split dummy matrix.

The full offline matrix ran 576 invocations across both providers and all six
splits, including protocol faults. It recorded zero required-line losses.
One OpenAI 10,000-line stress invocation emitted `publication recovery deadline`
while deferring publication cleanup. Its receipt, panel, saved
original, and prepared replacement were valid, but the runner treated the
stderr warning as an unexpected error. An isolated repeat passed all 121
requests without the warning. The original matrix failure remains in its
report; the repeat is in `batching-10000-repeat/`. This is an unresolved
cleanup-timing finding, not a model or privacy failure.

Lab-Control rejected allocation because its Docker filesystem reserve was
insufficient. Verification used the documented WSL fallback, the existing
locked toolchain, two Rust build jobs, and normal user-local caches. That initial investigation
changed the evaluation runner, fixtures, matrix, and documentation. It did not
build or install a plugin release. Live model-visible delivery was not tested.

## Follow-up order

1. Add narrowly validated projections for observed command-result wrappers.
   Preserve typed originals, status, cursors, stderr, and mixed-media rejection.
2. Narrow false diagnostic matches for explicit passing-test and zero-counter
   formats. Use paired real-error cases and retain unknown diagnostic text.
3. Add typed read-only routes for reviewed MCP tools. Keep credential and
   mutation boundaries intact.
4. Calibrate classification using held-out labels and confidence bins. Compare
   the combined excerptable probability with the true format. Do not treat
   confidence alone as evidence of safe omission.

For each step, publish the paired change in safe-opportunity coverage and
byte-weighted coverage. Use all enabled invocations as a separate context
metric. Do not lower the minimum size or raise the omission cutoff to meet an
API participation target.
