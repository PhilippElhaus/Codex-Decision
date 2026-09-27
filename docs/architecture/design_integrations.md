# Integration behavior

Codex Jev runs after a tool finishes. All three integrations start off. The hook reads the current selection when the result arrives.

| Integration | Local checks | Result after Jev approval |
| --- | --- | --- |
| Output filter | Repetitive text from 8,192 to 2,000,000 characters. | Short head and tail excerpts with a path to the exact original. |
| Test/build logs | A recognized direct command, routine lines, and a completion marker. | Failures, warnings, totals, and exit status stay visible. |
| Search/listing | A direct `rg -n`, `rg --files`, or `git ls-files` command with valid groups and a task cue. | Relevant groups and representative verbatim entries stay visible. |

The hook rejects sensitive-looking, malformed, or unsupported results before it calls Jev. The output filter checks large eligible results in bounded chunks; every chunk must pass before replacement. Test/build and search/listing send bounded summaries in one request and keep search groups when Jev is uncertain. Test/build and search/listing replacements must each save at least 30% and 1,024 characters. See [data handling](design_data.md) for request bounds and saved originals.

`observe` records a decision and keeps the full output. `replace` saves the exact original before it returns shorter text. A missing key, failed request, invalid answer, or uncertain judgment keeps the full result. With all integrations off, the hook makes no Jev request. The [config example](../../config.example.json) lists the settings.
