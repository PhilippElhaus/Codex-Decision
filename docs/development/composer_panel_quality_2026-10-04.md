# Composer and panel quality checks, 2026-10-04

This change keeps the compact Jev indicator on the composer toolbar and restores
the selected thread's latest decision after a VS Code reload. It pairs plugin
0.10.3 with control 0.9.6 and adds the exact-hash patch profile for Codex
`26.930.41038`.

## Confirmed defects and repairs

The old layout required 15 px for the compact button plus 15 px of margins.
A 28 px toolbar gap therefore moved the indicator above the prompt. The new
layout reduces compact padding and margins while preserving the 7 px dot.
It stays centered on the permission control's row. Gaps below 11 px hide the
indicator until space returns. Tests cover 8, 11, 12, 14, 24, and 28 px gaps and
restoration of the normal button.

A later fallback check removed every control to the right of the permission
button. Control 0.9.5 then overlapped that button by 8 px. Control 0.9.6 hides
the indicator while no right edge is available and restores it when the toolbar
returns. The browser harness checks both states.

The panel rejected decisions recorded before the provider started. A restored
thread also needed composer focus before the provider could select its session.
The provider now accepts the selected session's saved decision and selects the
first valid local session during startup. A ready handshake precedes delivery.
Dropped and rejected messages remain eligible for retry. A generation check
discards late reads and faults after a session or view change.

Snapshot reads remain bounded to 256 KiB even if a file grows after its size
check. Session changes reset the delivery cache and display delay. Normal status
polls no longer duplicate the panel's own polling. Windows settings writes use
six atomic rename attempts with up to 310 ms of scheduled retry delay. They
preserve the old file on failure.
Activity counts use the same English number format as the composer counters.

Classification calls do not produce panel rows. A classification that keeps
full output can leave the panel empty. A completed relevance batch produces the
rows. A successful API health check verifies API access; hook trust is checked
separately.

## Functional and fault checks

The Rust suite passed all 68 tests. Formatting and Clippy passed with warnings
treated as errors. Four Python checks passed. The current Node suite reports
62 tests: 61 passed on Linux and the native Windows test was skipped. The native
Windows run passed 59 tests, including the optional WSL test. Its three skips
cover Linux inode checks and file links that require Windows Developer Mode or
elevation. Directory junction checks ran on Windows.

Node coverage for the host control files is 96.14% of lines and 88.83% of
branches. The panel provider and snapshot reader both have 100% line coverage.
These figures exclude webview scripts, which have browser checks. A separate
64 MB heap run passed the current 62-test suite: 61 passed, and the optional
native Windows test was skipped on Linux.

Eight readers survived 200 atomic snapshot revisions. The native Windows WSL
test read the real UNC path while a Linux process replaced the snapshot 100
times. It verified independent session choices and Linux `700` directory and
`600` settings permissions. Fixtures contained synthetic data and were removed
after the checks.

An isolated native VS Code extension host loaded a disposable control copy and
the actual panel renderer under its CSP. Renderer acknowledgments confirmed
the displayed row count and header after restoring an older saved decision
without composer focus, three document reloads, hiding and reopening, and a
session switch. The instance used synthetic WSL data, an empty extension
directory, and a private
temporary profile. It closed and removed both fixtures after the check.
Five native runs passed. The helper binds each report to a unique run ID so
an early exit cannot reuse a previous successful report.

The offline corpus passed 145 cases with 379 mock API calls. It produced 41
completed panel decisions with matching receipt IDs, statuses, and request
counts. No required lines were lost. Fault cases preserved the full result and
rolled back partial decisions.

A separate zero-cutoff trial passed 62 cases and 104 mock calls. It kept every
line and produced 18 completed panel decisions. This verifies that completed
relevance judgments still appear when the configured policy makes no omissions.
The trial changed only private fixture settings.

A Monitor-mode trial produced a matching candidate receipt and 117 panel rows
from three mock calls while preserving all output. Its browser check passed
100 rounds, ten completed animations, and four reloads at 200% display scaling.
This separates a completed relevance judgment that keeps output unchanged from
a classification that produces no line judgments.

A bounded live test sent the synthetic `log-failure-240` fixture to Jev. Three
API calls produced 117 panel rows in 1,529 ms. The panel matched the receipt,
the saved original matched the input exactly, and both required diagnostics
were retained. Reported usage was 31,704 input and 4,772 output tokens. The
installed key remained in process memory. No private conversation was sent.

## Performance observations

A 100-round toolbar comparison used seed 17 and 5,000 synthetic history items.
It compared the same supported gaps against source revision `66114fd`.

| Measurement | Before | After |
| --- | ---: | ---: |
| Layout p50 | 7.7 ms | 4.6 ms |
| Layout p95 | 36.6 ms | 25.2 ms |
| Visited text nodes | 1,128,223 | 0 |

The named GPT button now bypasses a walk over the chat text. Fallback discovery
still runs when that button is absent. The two runs scheduled 224 and 234 layout
callbacks, respectively.

The panel stops assigning unchanged opacity during bar growth and stops
assigning unchanged widths after growth. Instrumented 117-row animations over
ten samples reduced median style setter calls per frame from 234 to 121.11
(48.25%). DOM mutation counts changed much less because Chromium already
suppresses many unchanged values. This measures removed JavaScript work, not a
claimed 48% reduction in paint time.

A separate 1,000-round memory probe omitted the timing array and collected
garbage before each 100-round sample. It rotated the current, full-keep, and
historical snapshots. Maximum retained JavaScript heap was 1,543,704 bytes for
the 5,000-item composer and 1,396,184 bytes for the panel. Panel node counts
stayed constant for each snapshot, and event listener counts stayed constant.
The probe completed in 478.106 seconds with no page errors. These measurements
cover these fixtures and this browser run.

The exact 11 px boundary passed in Chromium and native Edge. A combined smoke
and stress job exceeded its 240-second test limit while sharing the container's
CPU. The smoke checks had completed. The remaining 100-round stress check
passed separately in 128.203 seconds with ten completed animations and four
reloads. No product assertion failed in that timeout.

The Lab-Control container had one CPU. Other validation work ran during some
measurements. Browser timings include instrumentation and automation overhead;
they are observations for these fixtures rather than production latency limits.

## Long-running browser validation

Validation started at 07:33:18 UTC. All three long-running browser processes
had completed successfully by 11:40:02 UTC, exceeding four hours of work and
validation. They checked 50,537 rounds in total. Every round checked composer
geometry and rendered a hook-produced panel snapshot. All three processes
exited with code 0, without assertion failures or page errors.

| Run | Control | Duration, seconds | Rounds | Panel reloads | Completed animations |
| --- | --- | ---: | ---: | ---: | ---: |
| Initial | 0.9.5 | 6,601.792 | 28,615 | — | — |
| Mixed snapshots | 0.9.5 | 6,601.106 | 16,446 | 32 | 164 |
| Final toolbar recovery | 0.9.6 | 3,602.793 | 5,476 | 27 | 54 |

The initial runner did not record completed-animation or reload checks. The
mixed run rotated current, full-keep, and historical snapshots. The final run
removed and restored toolbar neighbours 547 times. Both later runs used 200%
display scaling and reduced motion.

The two initial runs visited no text-tree nodes. The final run visited
5,204,024 nodes because removing the toolbar controls exercised fallback model
discovery. The largest sampled composer heap across the runs was 3,273,020
bytes. The mixed and final runs sampled panel heaps up to 95,497,220 and
39,082,908 bytes, respectively. These unforced samples include transient
allocations and, for the composer, the runner's retained timing samples.
They do not establish retained memory or prove absence of leaks. The separate
garbage-collected probe above measures retained heap without the timing array.

The runner uses the real composer and panel scripts, a 5,000-item synthetic
history, and a hook-produced snapshot. Widths range from 360 to 2,800 px.
It varies permission labels, model heights, and toolbar gaps. Later passes
also checked completed animations, panel reloads, reduced motion, display
scaling, and separate panel heap samples.

Both 110-minute runs started with control 0.9.5. The additional missing-neighbour
guard in 0.9.6 has native Edge and Chromium regression checks. A separate
60-minute run tested the final source by removing and restoring neighbours every
ten rounds and reloading the panel every 200 rounds.

Native Edge passed the composer and current and historical panel checks.
Reports record actual viewport dimensions because Edge can enforce a minimum
headless window width. Edge's actual widths were 540, 680, 1,160, and 2,760 px.
Chromium checked 360, 720, 1,200, and 2,800 px directly.

Local deployment installed plugin 0.10.3 and control 0.9.6. The installed plugin
files match the ZIP. The control files match the VSIX except for VS Code's
added installation metadata. Both installed Codex versions, `26.930.31730` and
`26.930.41038`, have verified patch manifests and preserved rollback files.
The hook remains trusted and enabled. The running user window requires a reload
to load the new control and webview files.

[CI for the final source revision](https://github.com/PhilippElhaus/Codex-Jev/actions/runs/37196247680)
passed the Rust, Node, Python, offline corpus, package, and Chromium checks,
including toolbar disappearance and recovery.

Use [the test commands](../../tests/README.md#composer-and-panel-quality-checks)
to reproduce the regression and stress checks. Reports and key-free screenshots
are retained in ignored `.local/quality/` and `.local/two-stage/` locations.
The exported Lab evidence is under
`.local/quality/lab-evidence-2026-10-04/quality/` and
`.local/two-stage/lab-evidence-2026-10-04/two-stage/`. The quality export includes
all three completed soak reports, the memory probe, performance comparisons,
and a final 28 px-gap screenshot from the real visual harness.
