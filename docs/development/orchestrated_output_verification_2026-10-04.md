# Orchestrated output and compact panel, 2026-10-04

Plugin 0.10.4 and control 0.9.7 repair missing Jev decisions for code-mode
tool calls and reduce panel space.

## Confirmed cause

The active Codex transcript recorded the ordinary calls as `exec` custom
tools. The hook excluded `exec`, `wait`, and their `functions.*` names.
Hook health therefore reported `unsupported_route`; those calls made no
Jev requests. Direct synthetic Bash events reached Jev and displayed a
decision, which confirmed that the installed receipt-to-panel path worked.

The hook now previews text-only orchestration results. A known serialized
command envelope exposes decoded output lines instead of one escaped JSON
line. Its metadata remains in preview context. Unknown schemas and mixed
media remain intact. Orchestration results are never replaced, even with
MCP replacement permission. Their omission counts describe proposals.

## Panel and relevance questions

Each row occupies 27 px and contains a ten-character bar, a 0–100% value,
an excerpt, and an action. Responsive columns use the panel width. Hover
shows the decision reason and precise probability. The bar no longer
inflates near-zero scores to a minimum value. Browser checks verify that
all row contents stay on one line.

The 5% cutoff remains unchanged and inclusive. A score of 0.05 can be
omitted; 0.06 is kept. Local evidence rules can also keep low-scoring
lines. Tests verify that 0.05001 is kept without rounding the decision.

Questions now distinguish task evidence from routine counters, timestamps,
and line position. They ask for a relevance probability rather than a
keep/omit decision. They do not disclose or ask the model to target the
cutoff. Timing, event counts, order, and exhaustive tasks still require
their respective evidence.

## Validation

- All 71 Rust tests passed. Formatting and Clippy passed.
- Node reported 61 passes and one native-Windows-only skip on Linux.
- All four Python checks passed.
- The offline, holdout, and batching corpora passed 145 cases with 432 mock
  calls and no required evidence loss. Fault cases kept full output.
- Chromium and native Edge passed composer and panel checks. Fixed-width
  bars and single-line rows passed at narrow and wide widths.
- An isolated native VS Code extension host loaded the real renderer
  under its CSP. It passed saved-decision restoration, three reloads,
  hiding and reopening, and thread switching, with ten-character bars.
- Five live dummy cases used ten Jev requests. Logs, search matches,
  Unicode, build progress, and structured JSON retained all 112 required
  lines. Three replacements saved exact originals. Structured JSON stayed
  complete. API usage was 64,057 input and 6,693 output tokens.
- A separate live native-release `exec` event published a candidate panel
  with two requests and no required diagnostic omissions. The original
  orchestration response stayed unchanged.
- Both release archives passed exact-content, source-byte, and version
  checks. The README panel image uses the actual webview harness.

The live poll fixture's routine lines scored 3–5%, compared with the earlier
5–6% and higher scores near the end. Both required network search matches
scored 97%. Build progress scored above the cutoff and stayed complete.
These observations describe the dummy fixtures, not universal accuracy.

Evidence is retained in ignored `.local/quality/lab-fix-final-20261004/`,
`.local/two-stage/live-fix-0.10.4/`, and the dummy-inspection directory under
`.local/two-stage/`. Plugin data retains this thread's private live receipt.
