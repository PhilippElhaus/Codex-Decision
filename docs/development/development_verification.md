# Verify the local line migration

Builds use the user cache as Cargo's target directory, so the repository stays free of generated compiler artifacts:

```bash
CARGO_TARGET_DIR="$HOME/.cache/codex-jev/cargo-target" cargo test -p codex-jev
npm test --prefix vscode-control
python3 vscode-control/scripts/browser_smoke.py
```

The Rust suite checks exact UTF-8 line spans, bounded and unique targets, protected-line batching, search relevance, invalid Jev answers, offline gate trials, and fail-open process behavior. The browser harnesses render the actual composer and panel code. The ignored live Rust test makes output and search calls using a private key file and synthetic results, including the third search Noul; it writes only to a temporary data directory:

```bash
CODEX_JEV_LIVE_KEY_FILE=<private-PLUGIN_DATA>/.env \
CARGO_TARGET_DIR="$HOME/.cache/codex-jev/cargo-target" \
cargo test -p codex-jev live_line_request_records_valid_independent_answers -- --ignored
```

For reviewed quality cases, create a private JSON array with records like:

```json
[{"id":"failing-test-1","split":"holdout","receipt":"/private/receipt.json","required_lines":[5,6,9],"task_solved":true,"baseline_task_solved":true}]
```

Run `jevctl evaluate-quality --cases <private-cases.json>`. It reports required lines lost, characters saved, billed tokens when the batch responses supply usage, and labeled task outcomes by route and train/holdout split. Its offline gate trials replay the saved line probabilities at 95/5, 98/2, and 99/1, with a search relevance keep guard trial. Trials do not change settings or prove future task success. Cases and receipts can contain private data; keep them outside the repository. Choose candidate gates on train cases, then verify once against held-out cases. The 2026-09-26 live benchmark used the earlier coarse implementation and does not measure this release.

Package with `./scripts/build_submission.sh`, validate the plugin manifest, install the local package and paired VSIX, and test the installed Rust binary using temporary synthetic data. The user's current VS Code window does not need to be reloaded by automation; they can reload it when ready.
