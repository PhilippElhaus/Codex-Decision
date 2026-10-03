# Classification activity verification

Release 0.10.2 with control 0.9.3 separates composer activity from line decisions.
The hook records one classification-start event before its first API request.
The composer consumes it once and glows blue for 500 ms. Status polling can delay
the visible pulse by up to one polling interval, normally one second.
Relevance batches, completion events, classification skips, and connection checks
do not trigger another pulse. The Jev panel shows only relevance judgments and
keeps its previous decision when classification retains the full output.
Its header contains only the kept/judged count.

Validation on 2026-10-03 passed:

- 68 Rust tests, including an HTTP-server check that the classification event
  exists before the request arrives and occurs once across multiple batches.
- 45 Node tests, including phase counters, repeated polls, new-view isolation,
  classification skips, and request totals above the former 13-request bound.
- Four Python contract, package, and documentation tests; Rust formatting and Clippy.
- 145 synthetic output and fault cases, with no required evidence lost.
- Composer checks at 360, 720, 1200, and 2800 pixels in Chromium and native Edge.
  They cover the blue glow, pulse expiry, disabled controls, and replay prevention.
- Current and historical panel checks at 360 and 1200 pixels in both engines.
  They cover the reduced header, batch transitions, animation, and overflow.
- Package checks against exact source bytes and explicit archive allowlists.

The documentation captures use the real webview scripts with synthetic state.
They contain no keys or private conversations. These checks verify application
behavior; they do not establish model accuracy for every future output. The
classification questions, relevance judgments, and API batching policy are unchanged.
