# Reviewed Jev demo

On 2026-10-01, Jev 1.13.0 evaluated eight [synthetic fixtures](../../tests/fixtures/quality-cases.json). Four calibration cases cover build progress, heartbeats, stale search results, and a log containing an instruction to ignore the task. The latter requires the build ID and completion line; the injected instruction is removable data. Four holdout cases require failure details, every configuration constant, every matching timeout, and every latency measurement.

The reviewed 70% omission / 25% exact-text trial retained all 224 required lines, including all 214 required holdout lines. It shortened five results and kept three results complete. Every saved original matched the source byte for byte. These labels measure evidence retention; they do not establish downstream task success or a general error rate. The conservative 95/5 defaults remain unchanged, and their replay omitted no lines in this corpus.

| Case | Lines omitted / seen | Visible bytes saved | Outcome |
| --- | ---: | ---: | --- |
| Build failure | 116 / 125 | 2,781 | Version and diagnostics kept |
| Heartbeats | 112 / 121 | 3,522 | Final health summary kept |
| Current timeout search | 44 / 47 | 2,943 | Current paths and values kept |
| Failing tests, holdout | 119 / 124 | 3,390 | Expected/actual values and failure total kept |
| All constants, holdout | 0 / 90 | 0 | Every value kept |
| All matching timeouts, holdout | 0 / 60 | 0 | Every path and value kept |
| Deployment log with injected instruction | 101 / 103 | 2,772 | Build ID and completion kept |
| Measurement table, holdout | 0 / 60 | 0 | Every measurement kept |

On the identical build fixture and 70/25 policy, the pre-audit commit `8beb8a3` used four line requests and 29,076 input tokens. The revised hook used three requests and 21,081 input tokens: 27.5% fewer. Output tokens were 4,600 and 4,596. Observed elapsed time fell from 2.069 to 1.279 seconds; timing and individual probabilities can vary between calls. The old hook proposed 43 omissions but returned the whole result because the savings gate rejected its candidate. The revised hook shortened it. Reduced tool output does not imply lower total model cost; compare Jev input/output usage with the downstream savings.

The questions use direct named state references and an aligned exact-value criterion following the [Noul guidance](https://docs.typesafe.ai/primitives/noul) and Jev’s documented [sensitivity to indirection and irrelevant context](https://docs.typesafe.ai/model-jaggedness/jev-1.13). Cutoffs should be reviewed for the actual workload before changing installed settings.

Run the demo from WSL with Node 22 or newer and a debug hook build:

```bash
CARGO_TARGET_DIR="$HOME/.cache/codex-jev/cargo-target" cargo build --locked -p codex-jev
node scripts/demo_quality.cjs --live --data-dir /absolute/PLUGIN_DATA \
  --omit-min 70 --exact-max 25 --out .local/quality/my-review
"$HOME/.cache/codex-jev/cargo-target/debug/jevctl" evaluate-quality \
  --cases .local/quality/my-review/cases.json
```

The output directory must be new. Omit the cutoff flags to test the conservative defaults; `--case build-failure` selects one fixture. The runner sends synthetic requests through a loopback proxy, consumes the installed key only in memory, and removes its private temporary fixture data. It leaves synthetic receipts, batch records, a review manifest, and a summary under `.local/quality/`. It never changes installed switches, settings, keys, or retention.

The release hook fell from 6,001,984 to about 2,980,000 bytes; the two shipped binaries together fell by about 45%. Compact receipts keep the same version-2 replay format. Existing per-session retention settings and saved-original retention are unchanged.
