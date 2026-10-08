# Decision panel activity and skip investigation, 2026-10-08

Plugin 0.11.2 and control 0.10.7 keep the active thread’s API-request and skipped-output counts visible in the sticky upper-right panel header. Counts refresh during a displayed decision’s animation and rest period. An activity-only message does not resend or rebuild the line rows. Filtered results show removed/total lines. Previews show proposed removals, and full-output results show zero removed.

## Observed funnel

The initial inspected thread snapshot contained 22 enabled hook invocations, 21 skipped outputs, three recorded API requests, and one completed relevance result. It had no recorded API error. The synthetic failing-test report had 65 source lines. One relevance request judged 47 routine lines; all 47 were omitted. The 18 protected lines included the failure, assertion values, and completion totals. The hook recorded 1,644 characters saved.

| Initial skip reason | Outputs | API request before skipping |
| --- | ---: | --- |
| Sensitive output or tool input | 11 | No |
| Unsafe task context | 3 | No |
| Classification kept full output | 2 | Yes, one per output |
| Exact source content | 1 | No |
| Insufficient potential savings | 1 | No |
| No eligible independent lines | 1 | No |
| Short output | 1 | No |
| Unvalidated structure | 1 | No |

The hook runs after every matching tool result while enabled. An invocation is not an API request. Source reads, unsupported or structured responses, small outputs, credential markers, and impossible savings stop locally. An unknown format uses classification; failure to meet the 95% excerptability gate stops before relevance. A completed relevance result can still keep all lines or remain a preview. Connection probes are separate from hook evaluation.

The credential guard intentionally checks both output and command/input text. Documentation and inspection commands that mention credential markers can therefore be skipped even when they contain no credential value. This protection remains unchanged. Structured Lab-Control responses and unsupported tools also remain complete.

## Corrected blockers

The screenshot attached to the latest user request made its transcript record approximately 766 KiB, although the text task was only 502 bytes. The previous 64 KiB record limit treated that record as unsafe and blocked subsequent API evaluations. A tail window that started inside an image record could also mistake trailing user metadata for a malformed new task.

The hook now bounds complete records separately at 16 MB and task text at 64 KiB. It skips a partial leading tail record and rescans complete records. Only text parts enter task context; image data is never sent by this path. Image-only, malformed, sensitive, and excessive-text tasks still reject the current context without reusing an older task.

The timestamped heartbeat fixture used RFC 3339 timestamps before its log level. The previous local log contract did not recognize that prefix, so it used classification and kept full output. Valid RFC 3339 prefixes now use the existing independent-log contract. Invalid timestamps and mixed source prose do not qualify.

API totals previously advanced only after a recorded completion or classification skip. The hook now records attempts in hook health immediately before sending, so pending requests and failed answers remain counted independently of receipt/statistics rollback. A healthy existing session seeds its new attempt counter from its recorded request total. The separate connection probe is excluded. The panel and activity CLI use this counter and retain the older total as a compatibility fallback.

## Validation

Focused regressions cover large image records in either content order, partial tail windows, sensitive and oversized text, image-only tasks, oversized records, timestamp validation, persistent request counts after errors, and original-publication retries. Panel checks cover live activity during the display rest, stale-session reads, reloads, empty states, actual versus proposed removals, sticky visibility, and row/animation preservation. Native Windows VS Code checks use an isolated profile and synthetic WSL data. Documentation images render the real webview scripts through the visual and panel harnesses.

The previous live tool wrapper still displayed full text to the assistant while the hook recorded a replacement. The hook returns `continue: false`. [OpenAI’s hook documentation](https://learn.chatgpt.com/docs/hooks#tool-calls-from-code-mode) states that this supplies model-visible feedback but does not reject the nested JavaScript tool promise. The observed wrapper behavior is consistent with that contract: a script can still serialize its original returned result. A receipt establishes the hook’s decision and original publication, not end-to-end consumption by every wrapper. Changing to a blocking decision would reject the tool promise and turn routine filtering into a script error; this change preserves the existing continuation contract.

Validation passed: 147 Rust tests, Clippy, 68 Node tests with one Linux-only platform skip, four Python checks, Chromium and native Edge, and nine native VS Code panel checks. The OpenAI and TypeSafe base corpora passed 84 and 80 cases respectively, with zero required-line losses.

Local validation and synthetic reports are retained in ignored `.local/quality/panel-activity-20261008/`. Release packages use `.local/submission/`. Installed runtime data, session choices, provider settings, and credentials are preserved during deployment.
