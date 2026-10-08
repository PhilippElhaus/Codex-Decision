# Request accounting and reliability — 8 October 2026

Baseline: `d1de2d5` (plugin 0.11.4, control 0.10.10). This pass audits the
request path, supported output projections, private publication, historical
counters, and the actual VS Code consumers. The candidate is plugin 0.11.5
and control 0.10.11. The local release gates below passed; publishing follows the requested 18:00 Berlin boundary and requires a green new-commit GitHub run.

## What each count establishes

| Count | Commit point and meaning |
| --- | --- |
| Observed outputs | An enabled hook with valid scope and configuration records an invocation before output guards. Retries are additional observations. |
| Skipped outputs | A named local or classification skip reached its durable health-ledger write. A skip can follow a classification request. Errors that keep full output are recorded separately. |
| API requests / attempts | Durable request intent before transport. A connection failure does not prove provider receipt. |
| Attempts cancelled locally | Registered intent that exhausts the invocation deadline before transport starts. |
| HTTP responses received | Response headers were observed, including HTTP failures. |
| Responses validated | The complete bounded body, JSON, provider shape, model, and typed answers passed validation. |
| Requests failed | Transport, body, JSON, provider, or typed-answer validation failed. This includes HTTP failures. |
| Completed line evaluations | All required decision artifacts, totals, snapshot, and completion event reached the explicit committed publication marker. |
| Outputs filtered / lines removed | A committed replacement payload omits these lines. Monitor previews contribute no actual removals. Consumer delivery is not acknowledged by the hook. |

Counts describe different stages. They are not a single funnel with one request
per output: classification is optional for validated formats, relevance can
span several requests, and failed publication can follow valid responses.
The request average uses recorded request timings, including classification
keeps, rather than the number of completed outputs.

A skipped output is delivered complete. The recovered routes target avoidable
format and context failures: validated Lab logs, supported Go/Cargo/search
projections, complete task records, and ordinary build progress. Credential
protection, exact source or diffs, complete-result requests, genuinely coupled
structures, short outputs, and unsupported mixed-media envelopes remain
explicit gates. Changing their historical counts would invent processing that
did not occur. Separate connection checks are excluded from hook API totals.

Fresh ledgers carry counter scheme 1 and an exact zero baseline. Earlier
history retains its values and explicit incomplete coverage. Consumers show
`≥` for recorded lower bounds and `—` for unknown metrics. They do not invent
missing history. Invalid or unreadable activity retains the selected thread
and recovers after repair. Counter overflow is rejected before publication;
installation sums that exceed JavaScript's exact integer range are unavailable.

Events-only history contributes only bounded retained minimums. Missing timing
data makes an average unknown: a ratio of two lower bounds is not itself a
lower bound. Shared malformed-record fixtures check duplicate fields, unsigned
numeric tokens, UTF-8, row boundaries, and partial history across consumers.
An unresolved intent makes the four request-outcome totals lower bounds until
all intents have recorded terminal outcomes. Legacy retained attempts cannot
establish received or validated response counts. Valid Rust `u64` values beyond
JavaScript's exact integer range remain precise in Rust and unavailable in Node.
The historical Python ledger also incremented `calls` before transport and
`timed` per output. Unlabelled and migrated ledgers therefore cannot supply a
validated-response minimum or a per-request timing mean. Their raw values stay
preserved; actual health-ledger responses remain visible and the ambiguous
average is unknown. Only fresh scheme-1 completion ledgers with complete
coverage contribute that response minimum and timing scope.
Recorded timing averages use integer quotient and remainder arithmetic. Shared
boundary fixtures cover normal rounding, ties, JavaScript's exact range, and
Rust's full `u64` range without a floating-point rounding step.

## Demonstrated corrections

- A held health lock could consume the invocation budget before the HTTP timer
  started. The send boundary now rechecks the remaining budget after durable
  registration and records a known local cancellation when no send starts.
- Redirects could produce additional HTTP traffic behind one registered
  request. Decision POSTs now reject redirects. Six redirect status fixtures
  each observe one intent and one HTTP request.
- A pinned TypeSafe request could accept an answer naming a different Jev
  version. Pinned version IDs now match exactly; the documented moving aliases
  accept canonical version IDs without pinning the user's selection. Exact
  alias echoes remain compatible with synthetic fixtures. This follows the
  provider's distinction between [aliases and response model IDs](https://docs.typesafe.ai/models).
- A malformed synthetic endpoint override could fall back to a real provider
  or admit userinfo through a prefix check. Explicit invalid overrides now
  fail locally; verification accepts only a strict loopback endpoint.
- Classification-only completion events could precede a failed stats write,
  and a killed line evaluation could leave new totals without its event.
  A bounded private journal now tracks prior and next images and exact event
  bytes. Prepared publications roll back even after a complete event fsync;
  only the explicit atomic committed marker finalizes a publication.
  Producers recover under the existing log lock, and readers expose the prior
  committed totals and history while a publication is prepared. Changed or
  unknown images are refused without deleting user content. Cleanup after
  the marker cannot cancel the result; retention waits for deferred cleanup.
- Independent reads could combine older health with newer completion totals.
  Current exact ledgers get one bounded health retry if the stages conflict;
  a persistent conflict becomes unavailable data. Legacy bounds stay partial.
- An older hook finishing during an upgrade could preserve new ledger fields
  without updating the new request outcomes. The affected metrics immediately
  become partial, and the next current writer persists that coverage downgrade.
- The control could interpret duplicate settings differently from the hook.
  Configuration and settings now use bounded reads and the shared strict
  JSON/UTF-8 codec; ambiguous records are rejected without rewriting them.
- Lossy transcript decoding could accept invented replacement characters in
  a corrupted latest task. Complete records now require valid UTF-8; a valid
  newer task still restores processing. Partial tail rows are discarded before
  decoding, so ordinary multibyte boundary cuts remain valid.
- An interrupted publication left correct originals that blocked an identical
  retry. Reuse now requires an exact private owned regular file and matching
  typed envelope. A permanent session lock covers saving, publication, and
  rollback so an overlapping cooperating 0.11.5 invocation cannot lose a
  leased original. Older executables do not implement that mutex; deployment
  updates every pinned payload and allows the old hook process limit to pass.
- Valid Go/Cargo JSON and numbered search results could be skipped because
  stderr was validated as stdout. Stderr remains protected; format checks
  validate the actual stdout contract.
- Search JSON records lost offsets and submatch details in their provider
  projection. The model now receives the complete record. Duplicate fields
  and unsupported binary records stay local.
- Typed Go panic continuations and benchmark results, and Cargo diagnostic
  records, now retain their coupled evidence. Real exhaustive task phrases
  remain protected without matching unrelated identifier suffixes.
- The final matrix caught a structural guard interpreting Ninja progress
  counters such as `[37/180] Building …` as a JSON array. Known counter and
  progress-verb combinations now remain eligible. JSON after a counter,
  ambiguous records, and actual arrays remain protected. Regression cases
  cover the repaired build, near-target-limit, and 253-line progress routes.
  The privacy decoder shares that grammar so safe Windows paths in progress
  lines do not get mistaken for malformed JSON. Credential checks still run.
  Validated native and wrapped Lab polling results recognize the same build
  records under the existing whole-log density, prose, and status checks.
  Unsupported generic MCP results retain their configured policy.
- Escaped JSON, literal Unicode escapes, and ANSI removal could conceal
  credential markers from the raw check. Bounded temporary decoded checks
  now inspect the interpretation that can enter provider context, including
  protected rows and metadata. Originals and model text remain unchanged.
  Ambiguous structured source also stays local; a protected skip does not
  necessarily establish that the source contained a credential. Incomplete
  historical protection details display their own lower-bound markers.
- Filter mode with generic MCP replacement disabled could spend relevance
  requests on a result that would only become a preview. That policy gate
  now runs before requests. Authorized validated Lab command logs retain
  their separate supported route; Monitor still evaluates previews.

## Efficiency

Pure classification keeps and failed invocations now compact their event
stream before appending, without scanning receipt trees on each invocation.
The event stream reserves space under its 1 MiB cap and retains complete rows.
An incomplete tail is repaired under the log lock; `never_delete_logs` retains
its bytes. Active journals prevent compaction until recovery completes.
Legacy fallback consumers read at most 1,048,576 bytes and accept only complete
rows of at most 8,192 UTF-8 bytes. A synthetic 1.88 MiB log confirmed that read
bound. Sixteen shared adversarial cases agree across the Rust helper, actual
CLI, and Node, including explicit unavailable values for representation limits.
Historical producer inspection confirms that Python request-start events have
no overlapping outcome request count; the Rust producer adds outcome counts
without those legacy starts. Retained mixed-version history can therefore sum
these disjoint recorded facts while keeping incomplete coverage explicit.

One redundant neighbor-protection pass was removed after seeded idempotence
checks. OpenAI wire encoding now streams quoted state and instruction data
without intermediate full strings. Complete byte comparisons preserve the
provider request contract. This reduces local allocation and encoding work;
it does not reduce provider tokens or change questions and cutoffs.

An alternating baseline/candidate/candidate/baseline benchmark pinned to one
CPU preserved complete wire fingerprints. Relevance encoding allocations fell
from 282 to 10 for the small fixture and from 50 to 7 for long-line input;
allocated bytes fell 48–54%. Median relevance encoding CPU time improved
2–25%, and classification encoding improved 11–15% on these fixtures.

A six-round warmed, alternating-order 250-session read benchmark measured
median 486.27 ms with one reader and 400.37 ms with four bounded readers.
At most eight file handles are open. Failed readers are joined before the
aggregate rejects. Token estimates are recomputed from aggregate saved
characters rather than summed independently rounded session estimates.

## Evidence and limits

The final full matrix passed 510 cases across ten provider/split runs with
808 matching mock requests, no required-line loss, no protected targets,
and no unexpected hook errors. This includes the final build-counter repair.
The literal Unicode decoder also agrees with
the JSON decoder for every single BMP codepoint. Native VS Code passed 14
checks, including session restoration, persistent Totals, reloads, hidden
views, protected rows, live counters, and unreadable-data recovery.

Twelve additional live OpenAI cases passed with 149 required lines and no
actual required-line loss. All text and typed originals matched. These used
the recorded pre-journal verification source; the journal is checked separately
with exact synthetic crash barriers. The two live runs observed 19 provider
HTTP requests and 20 local proxy/hook attempts. One additional attempt was
blocked locally by the test budget after returned usage exceeded its threshold;
the incomplete case stayed full and passed in a separately bounded rerun.
Reported usage was 324,969 input tokens and zero output tokens. The original
incomplete report is retained and excluded from accepted-case totals.

Native Windows-to-WSL tests verify prior totals, snapshot, and cursor reads
during preparation, committed reads, rollback, and identical retry. Actual
Linux SIGKILL barriers cover both providers before and after stats, snapshot,
event fsync, and the marker, plus concurrent retry and deferred cleanup.

Both fixed C8 matrices passed with request, reply, and byte fingerprints
matching the frozen baseline. Each ran 96 invocations: 72 replacements and
24 deliberate failures. Request outcomes were checked after every group.

| Provider | Attempts | Headers received | Validated | Failed | Cancelled |
| --- | ---: | ---: | ---: | ---: | ---: |
| OpenAI | 2,940 | 2,936 | 2,916 | 24 | 0 |
| TypeSafe | 2,784 | 2,780 | 2,760 | 24 | 0 |

Neither matrix lost telemetry or fell back on the invocation deadline.
Matched runs with the same memory sampling took 33.10/35.21 seconds for
OpenAI baseline/candidate and 32.53/32.90 seconds for TypeSafe. Publication
recovery adds local work; these results establish no whole-pipeline speedup.
TypeSafe's observed owned-hook high-water marks were 58,316/58,476 KiB.
Sampling reports observed maxima, not guaranteed unsampled process peaks.

Two additional 30-minute candidate runs used eight concurrent hooks and
64, 512, 2,000, and 10,000-line inputs. They completed 11,792 invocations:
8,844 committed replacements and 2,948 deliberate fault cases. Every group
reconciled its mock requests with durable intents and request outcomes.

| Provider | Attempts | Headers received | Validated | Failed | Cancelled |
| --- | ---: | ---: | ---: | ---: | ---: |
| OpenAI | 175,424 | 175,186 | 173,996 | 1,428 | 0 |
| TypeSafe | 177,068 | 176,816 | 175,548 | 1,520 | 0 |

The runs recorded no telemetry-write failures, deadline fallbacks, sampling
errors, or unexplained accounting gaps. At 100 ms sampling, individual hook
high-water marks reached 59,392/60,256 KiB, concurrent hook RSS reached
406,548/403,544 KiB, and harness RSS reached 311,320,576/336,347,136 bytes.
The memory sampler includes only owned hook children; whole-container memory
also includes RAM-backed source, build caches, and test data. A browser shared
the server during the final TypeSafe segment, so the soak establishes
acceptance under that load, rather than a comparative performance result.

The long runs preceded the final progress-format corrections and exact
read-average repair. Request transport, durable counter writes, and journal
code were unchanged afterward. The full matrix, both
fixed C8 pressures, staged retries, concurrent rollback, and all 16 actual
publication-kill scenarios passed again using the final runtime source.

The final Linux Node run passed 108 tests with two native Windows tests
skipped. Native Windows passed 106 tests with four platform/CLI tests skipped,
including both active Windows-to-WSL publication tests. The shared actual
Rust CLI/Node adversarial differential ran in the Linux suite. Four Python
checks passed, including exact package allowlists and rejection of a
verification hook from a production archive.

The resident browser run completed 3,601 seconds and 1,638 updates with two
10,000-row provider snapshots and smaller reviewed fixtures. It passed 327
settled-animation checks, 40 panel reloads, and 163 toolbar fallback checks,
with no page errors. Sixteen checkpoints observed composer heap up to
2,731,228 bytes and panel heap up to 60,685,636 bytes. These are sampled
JavaScript heaps during a shared-server acceptance run, rather than process
RSS limits or a latency comparison. Final-source Chromium and native Edge
smokes separately cover the later Totals wording, coverage, and wrapping rules.

A deterministic controller test holds a timer read while metadata changes.
Concurrent statuses share the already-open snapshot; the next fresh read must
report unavailable counts for corrupt data and restore the durable counts after
repair. Metadata-change integration assertions drain that older flight before
checking a fresh read. This removes a demonstrated load-dependent test race
while preserving production refresh coalescing and strict null/fault checks.
The narrow-panel harness also verifies full exact-range counter text, wrapping,
pending-stage lower bounds, and incomplete protection detail counts.

The final Rust suite passed all 257 tests under both `022` and `077` umasks,
with formatting and all-target Clippy clean. Both production archives pass exact
entry allowlists, source-byte comparison, binary target and version checks; the
production hook contains no verification endpoint. Synthetic assertions
establish behavior for the reviewed corpus. They cannot guarantee universal
model accuracy.

The GitHub Actions mail audit inspected 32 runs. Six historical failures traced
to private-directory permissions, deadline-test fixtures, and toolchain setup;
their fixes are already in the baseline. A fresh rerun of `d1de2d5` passed both
jobs. The new workflow adds the staged-retry, concurrent-rollback, and explicit
publication-marker interruption gates. Its new-commit result is required
before publishing this release.

The existing ureq resolver can spend time outside its HTTP timeout; the outer
60-second hook limit remains the process boundary. No unbounded background
resolver or automatic provider retry was added. A terminated process can leave
registered intents with no known outcome; these must remain distinguishable
from provider-confirmed responses.

The journal establishes recovery from the tested process interruptions. It
does not prove universal power-loss durability or consumer delivery. A kill
inside the generic atomic-file staging helper can strand a random private
scratch file; recovery preserves files whose ownership it cannot establish.
Classification metadata and its later skip-health record have separate commit
points; termination between them can leave a committed classification event
without a recorded skip. Counts establish the recorded stages, rather than
inferring an unacknowledged final invocation result.

The code-mode wrapper limitation remains: a receipt establishes the hook's
decision and saved original, while a JavaScript wrapper can still expose its
original return value. Removal counters do not establish downstream token
savings for that route.
