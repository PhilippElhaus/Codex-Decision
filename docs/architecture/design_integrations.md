# Integration behavior

Codex Jev runs after a tool finishes. All three integrations start off. The hook reads the current selection when the result arrives.

| Integration | Local checks | Result after Jev approval |
| --- | --- | --- |
| Output filter | Repetitive text from 8,192 to 2,000,000 characters. | Short head and tail excerpts with a path to the exact original. |
| Test/build logs | A recognized direct command, routine lines, and a completion marker. | Failures, warnings, totals, and exit status stay visible. |
| Search/listing | A direct `rg -n`, `rg --files`, or `git ls-files` command with valid groups and a task cue. | Relevant groups and representative verbatim entries stay visible. |

The hook rejects sensitive-looking, malformed, or unsupported results before it calls Jev. The output filter checks large eligible results in bounded chunks; every chunk must pass before replacement. Test/build and search/listing send bounded summaries in one request and keep search groups when Jev is uncertain. Test/build and search/listing replacements must each save at least 30% and 1,024 characters. See [data handling](design_data.md) for request bounds and saved originals.

`observe` records a decision and keeps the full output. `replace` saves the exact original before it returns shorter text. A missing key, failed request, invalid answer, or uncertain judgment keeps the full result. With all integrations off, the hook makes no Jev request. The [config example](../../config.example.json) lists the settings.

`thresholds` stores whole percentages per hook. Output and test/build each require a minimum routine-noise probability and maximum probabilities that exact text or a unique value matters. The same request also asks a Choice question: filter or keep. Filtering requires a `filter` answer and Jev's reported [Choice confidence](https://docs.typesafe.ai/confidence) at or above the configured minimum. For chunked output, every chunk must approve filtering; the lowest confidence governs the result. Search/listing has separate probability and confidence minimums for summarizing and dropping groups. The **Jev** page in Codex settings edits these values; omitted values use the conservative defaults. The structural and sensitive-data checks still run before these thresholds.

[Noul](https://docs.typesafe.ai/primitives/noul) fits the three independent yes/no safety checks. [Choice](https://docs.typesafe.ai/primitives/choice) fits the mutually exclusive filter/keep action and the existing search/listing retain/summarize/drop action. [Score](https://docs.typesafe.ai/primitives/score) would fit graded relevance or severity for records with a known task and ordered rubric. A JSONL row's format alone does not establish its value to the task, so generic line-by-line scoring is not an output filter. A future record-ranking integration should preserve every exact record, use bounded batches, and test its rubric against representative tasks before it can omit lines.
