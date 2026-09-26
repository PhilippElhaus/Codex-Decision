# Additional measurements, 2026-09-26

A prior 90-case live Jev replay made 30 calls and selected 10 repetitive Bash
outputs with no false or missed replacements against synthetic labels. Those
labels do not establish accuracy on real tasks.

On 2026-09-26 the Jev-gated test/build smoke ran the actual plugin Python suite, a
failing Python unittest suite, a Node test suite, and a C build through the
`PostToolUse` adapter. Their respective model-visible text reductions were
95.2%, 82.7%, 93.5%, and 90.2% by character count after Jev approval. It
verified Jev request events and scores, failure details, summaries, exit code,
exact original recovery, and observe mode. This
is a controlled set of command outputs, not a full-task token or cost measurement.

On 2026-09-26 the search/listing smoke asked Jev about a real 18,673-character
repository search. Jev was uncertain, so the hook kept it intact. A separate
12,760-character `rg --files` listing was reduced to 4,183 visible characters
(67.2% smaller); the exact original remained recoverable. This is a
hook-level character comparison, not a measured full-task token saving.

A later installed-hook sample with all three filters selected wrote three
outcomes to the live Jev history. Each call returned a shorter model-visible
response and saved an exact, owner-only original:

| Filter and input | Original | Visible | Character reduction |
| --- | ---: | ---: | ---: |
| Repetitive output, 400 generated progress lines | 12,800 | 912 | 92.9% |
| Test/build, actual plugin Python suite | 7,945 | 309 | 96.1% |
| Search/listing, actual `rg --files` over a disposable corpus | 12,760 | 4,193 | 67.1% |

These are three controlled tool results, not full-task savings or billed token
measurements. The search smoke also kept a real repository search intact when
Jev was uncertain.

An oversized command-hook run checked all three filters with 2.08–2.46 million
characters per result. Each returned the original unchanged in 251–260 ms,
made no Jev request, and wrote no saved original. The maximum eligible result
is two million characters; the limit avoids paying for an oversized judgment.

On 2026-09-26, three live Jev calls per active mode against synthetic
11.5k-character Bash logs gave these hook-level results through the actual
Windows credential bridge:

| Mode | Median hook wall time | Model-visible tool text across three runs |
| --- | ---: | ---: |
| Off | 445 ms | 34,656 characters |
| Observe | 1,562 ms | 34,656 characters |
| Replace | 1,614 ms | 2,697 characters |

All three replace calls selected replacement, a 92.2% character reduction.
The wall times include Python process startup and bridge work, and varied from
run to run.

A second 2026-09-26 run used five live Jev calls per active mode and exact
`o200k_base` counts for the same synthetic build logs:

| Mode | Median hook wall time | Model-visible tokens across five runs |
| --- | ---: | ---: |
| Off | 213 ms | 16,290 |
| Observe | 1,381 ms | 16,290 |
| Replace | 1,385 ms | 1,316 |

All five eligible replace calls succeeded. The **91.9% token reduction** on
those outputs saved 14,974 tokenizer units while adding a median 1.17 seconds
of hook latency per call against off. A rough break-even would require the
downstream model to process at least 2,555 input tokens per second if no other
latency changed; that rate has not been measured here. Context relief can
still matter when time savings are zero. A separate live 27-case replay made
Jev calls only for eligible text; it selected all three repetitive Bash cases,
observed three text MCP cases, and kept 21 other results, with zero mismatches
against synthetic labels.

The 200-case mocked policy/context benchmark selected 20 repetitive outputs,
left 180 unchanged, and removed 61,990 of 545,170 `o200k_base` tokens (11.4%
across this deliberately mixed corpus). The selected outputs alone shrank
93.2%, saving a median 3,100 tokens per selected output, about 2.4% of a 128k
context window. These figures are context-size estimates, not measured Codex billing or
full-task savings. They apply only if raw tool text reaches the model; a nested
tool script that already summarizes the text gets little or no benefit.
