# Integration design

Codex Jev offers three independent `PostToolUse` integrations. All start off. The hook routes recognized test/build commands first, supported searches and listings second, and other results to the repetitive-output filter. Each eligible result makes at most one Jev request. The next completed tool result reads the current selection.

| Integration | Local gate | Replacement |
| --- | --- | --- |
| Output filter | Repetitive text of 8,192 to 2,000,000 characters. | A short head/tail excerpt and the exact original's path. |
| Test/build logs | A direct recognized command, at least eight routine lines, and a completion marker. | Preserve failures, diagnostics, totals, and exit status; omit approved pass or progress lines. |
| Search/listing | A direct line-oriented `rg -n`, `rg --files`, or `git ls-files` command with valid groups and a task cue. | Keep relevant groups and representative verbatim entries; compact only groups Jev rates as low value with high confidence. |

## Output filter

The hook rejects small, oversized, sensitive-looking, diagnostic, structured, or media results before a Jev call. It samples at most 12,000 characters by default. Jev rates routine noise, need for exact text, and one-off value. Only a strong, valid judgment can replace the output. The exact original is saved first.

Text-only MCP responses are observed by default. Set `allow_mcp_replacement: true` in `config.json` to allow replacement.

## Test/build logs

The hook recognizes direct commands such as `python -m unittest`, `pytest`, `node --test`, `npm test`, `cargo build`, `go test`, and `make build`. It rejects compound shell commands. It considers logs from 2,048 characters upward and retains warnings, failures, diagnostics, completion summaries, and exit status.

The hook proposes known pass or progress lines for omission. Jev judges bounded omitted and retained samples. Replacement requires Jev approval, a completion summary, and a reduction of at least 30% and 1,024 characters. Unrecognized and short logs stay intact.

## Search and file listings

The hook rejects compound commands, malformed rows, sensitive-looking text, and listings without a recent user task. A search command can provide the task cue. One batched Choice request rates at most 12 path groups. Uncertain groups stay verbatim. Summarized groups keep representative entries. A replacement must save at least 30% and 1,024 characters and fit within 8,000 characters.

## Outcomes

`observe` records decisions and keeps full tool output. `replace` returns shorter text only after the hook saves the exact original. A missing key, Jev outage, invalid answer, or uncertain judgment keeps the full result. Clearing all selections makes no Jev request or decision log entry.

The filter acts before tool text enters Codex context. It does not change Codex's built-in compaction. See [data handling](design_data.md) for request limits, saved originals, and the API key. The [config example](../../config.example.json) lists all defaults.
