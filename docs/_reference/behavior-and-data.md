# Integrations, decisions, and data

## Decisions and data

| Gate or outcome | Behavior |
| --- | --- |
| All integrations unselected | No Jev request or log entry. |
| Broad search/listing command with the third filter selected | Validate the line format and task cue locally, batch Jev choices for at most 12 path groups, then keep exact relevant entries and compact only high-confidence lower-value groups. |
| Recognized test/build command with test/build filter selected | Locally identify known pass or progress lines, then ask Jev whether omitting them is safe. Replace only when Jev approves, a completion summary remains, and reduction exceeds 30% and 1,024 characters. Retain other lines and the exact original. |
| Test/build filter in observe mode | Ask Jev and record its judgment; Codex receives the full result. |
| Fewer than 8,192 or more than 2,000,000 characters | Skip locally. |
| Secret-looking input/output, diagnostics, structured or media MCP response, or low repetition | Keep full result; no Jev request. |
| Jev unavailable, invalid scores, or uncertain decision | Keep full result. |
| Strongly repetitive Bash output in replace mode | Save exact original, then return a head/tail excerpt and its path. |
| Eligible result in observe mode | Record a candidate; Codex receives full result. |
| Eligible text-only MCP output | Observe by default; set `allow_mcp_replacement: true` in `config.json` to opt in. |

The test/build filter recognizes direct commands such as
`python -m unittest`, `pytest`, `node --test`, `npm test`, `cargo build`, `go test`, and
`make build`. It rejects compound shell commands. It considers logs from
2,048 characters upward, requires at least eight routine lines and a
completion marker, and retains failures, warnings, diagnostics, and summaries.
It sends bounded samples of proposed omitted and retained text to Jev for
three judgments: routine noise, need for exact text, and one-off value. Jev
must approve before replacement; unavailable or uncertain judgments keep the
full log. The samples share the output filter's credential boundary.
Unrecognized and short logs remain unchanged. The hook routes recognized
test/build commands first, supported search/listing commands second, and other
results to the repetitive-output filter. Selection can change during an active
session; the next completed tool result reads the current config. A result is
sent to Jev at most once.

## Broad search and file listings

The third filter handles direct, line-oriented `rg -n`, `rg --files`, and
`git ls-files` Bash commands. It skips compound commands, structured output,
small lists, malformed rows, sensitive-looking text, and listings without a
recent user task from the session transcript. For searches, the command itself
can provide the task cue. The request contains only a short task cue and at
most 12 path-group descriptors, capped at 7,000 characters. The full Jev
request is capped at 10,000 characters; the full result
is not sent to Jev. One batched Choice request rates each group. A group is
dropped only at very high probability and confidence. Uncertain groups remain
verbatim, and summarized groups keep representative verbatim entries. The
replacement is capped at 8,000 characters and must save at least 30% and
1,024 characters. Otherwise Codex gets
the full result. The exact original is saved before any replacement and its
path appears in the shorter response. Observe mode evaluates without replacing.

This filter trims tool text before it enters context; it does not change
Codex's built-in compaction. The former `PreCompact` handoff is removed because
that hook cannot replace compaction input and did not directly save context.

Before a Jev request, the output filter filters locally and samples at most
12,000 characters by default. Jev answers three `Noul` judgments: routine
noise, need for exact text, and one-off value. The sensitive-content filter is
conservative and cannot prove arbitrary text is safe to send to an external
API; enable the hook only where this data boundary is acceptable. The Jev
request has a three-second deadline; the tool-output hook has a five-second
timeout. Search/listing requests can include up to 500 characters of the most
recent user task from the transcript; enable it only where sending that
excerpt to Jev is acceptable.

The exact original is stored at
`PLUGIN_DATA/outputs/<session-hash>/<call-hash>.txt` with owner-only permissions.
The API key is read from the private `PLUGIN_DATA/.env` file only when an eligible
result needs a Jev request. It is sent directly to Jev in the HTTPS Authorization
header and is never written to the decision log or returned tool text.
The replacement text names that path for recovery. `PLUGIN_DATA/events.jsonl`
stores decision metadata, filter name, scores, sizes, and elapsed time, not raw output. The
extension reads only this metadata. Do not publish the plugin data directory;
saved originals are retained until you remove them. The
[config example](../../config.example.json) lists all defaults: enablement, mode,
minimum and maximum size, sample size, timeout, model, and MCP opt-in. The
plugin rejects unknown or invalid config values.

The VS Code control estimates savings for each replacement from the original
and excerpt character counts. Its percentage describes shorter model-visible
tool text, not exact tokenizer counts or billed-token savings.

Hosted tools such as web search do not pass through this hook. For nested
JavaScript tool calls, Codex returns the original result to the running script.
Replacement reduces model-visible text only when the raw result would
otherwise reach the model; a script that already summarizes output gains
little or no model token savings.
