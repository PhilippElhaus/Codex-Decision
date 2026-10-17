# Startup and UI repair, 2026-10-17

Codex Decision 0.12.1 repairs temporary startup failures and makes composer and panel activity consistent. It keeps the existing classification gate, relevance cutoff, provider settings, and evidence-preservation rules.

## Observations and changes

The October 17 Windows VS Code logs contain a bundled-hook installation failure after restart. One window later reached ready state; another retained the failure. The former generic diagnostic discarded the underlying exception category, so the original operating-system trigger cannot be recovered from those logs.

The installer now reports a fixed installation phase and failure category. Temporary file/process access failures and timeouts permit three automatic retries after 2, 5, and 15 seconds. A successful retry stops recovery. Disposal and disabling automatic repair cancel pending retries. Invalid metadata, permission errors, conflicting registrations, downgrades, and security refusals do not retry. OS paths and child-process output stay out of diagnostics. Host-file verification and hook trust remain separate checks.

Eleven installed session scopes retained an error followed by a newer normal skip. The old composer compared that error only with the last successful evaluation. The panel also considered newer skips. This could show conflicting health for the same thread. Reopening the webview could hide a saved error in the composer while the panel retained it.

Composer and panel now share the latest hook-outcome summary and saved request/skip counts. A newer skip or successful evaluation clears an older error. Saved errors survive reload. The indicator reflects current hook, version, configuration, and panel failures as well as API connectivity. A saved receipt from an earlier hook version requests fresh verification in amber; a fresh mismatched receipt reports failure. The tooltip labels API connectivity separately. The panel keeps the latest hook status visible while retaining an earlier line evaluation.

The indicator used a near-maximum stacking level above Codex dropdown menus. It now uses layer 40, above the supported host's normal composer and below its menu layers 50 and 70. Browser hit tests cover both the indicator and focused tooltip while a menu is open, then verify that the control is reachable after the menu closes.

## Usage and delivery

The [usage audit](usage_effectiveness_2026-10-17.md) bounds API participation at 7.34–7.78% of enabled invocations in its exact historical cohort. Small outputs and exact reads account for about 62% of invocations. Classification keeps already contacted the provider; one output can also require multiple requests. The audit now includes classification-only timing and usage, reconciles skip-reason coverage, and preserves truncated recent-tail coverage.

No inspected evidence justifies weaker privacy checks or a higher omission cutoff. Current-format saved originals remain byte-exact. Normal-session model delivery remains unverified. The [official code-mode contract](https://learn.chatgpt.com/docs/hooks#tool-calls-from-code-mode) preserves the nested JavaScript promise when Decision returns `continue: false`. Changing this to a blocking result would reject the promise and alter script behavior.

## Validation

- Rust: 272 tests, formatting, and Clippy with warnings denied passed.
- Node: 158 passed; three platform/optional tests skipped on WSL. Python: 16 passed.
- Both-provider synthetic matrix: 510 cases, 808 mock requests, zero required-line loss, and zero failures.
- Native Edge rendered the real composer, settings, and panels, including menu layering, restored errors, skip recovery, version checks, and thread navigation.
- Chromium passed the full composer, settings, and panel suite at 360–2,800 px, including visible latest-hook updates that preserve earlier line rows.
- A 50-round Chromium layout run completed with ten toolbar-fallback checks and no page errors.
- The exact integrated VSIX passed two isolated native Windows launches, eight checks each. The first launch recovered automatically from a fixture-only temporary installer failure. The second launch verified restart idempotence.
- A live OpenAI check sent only reviewed synthetic output through an isolated proxy. Three requests evaluated one 242-line result, preserved both required lines and the exact original, and matched the receipt and panel. This does not establish normal-session delivery.

The VSIX SHA-256 is `8d07b812c6c04004bcbfba2d8964606f70b37be334e06e60986fea8b1eab7f7f`. Both the integrated VSIX and standalone ZIP passed exact allowlist, source-byte, production-binary, and version checks. Screenshots capture the current webviews with synthetic, key-free state.

Lab-Control capacity was occupied by other tasks. No foreign session was stopped or reused. The documented WSL build path and native Windows checks supplied validation. Reports and submission artifacts remain in ignored `.local/quality/` and `.local/submission/` locations.
