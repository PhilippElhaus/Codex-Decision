# Tests

Run the current release checks from the repository root. The offline tests use synthetic tool output and Jev replies; they do not need an API key.

```bash
CARGO_TARGET_DIR="$HOME/.cache/codex-jev/cargo-target" cargo test -p codex-jev
CARGO_TARGET_DIR="$HOME/.cache/codex-jev/cargo-target" cargo clippy --all-targets -- -D warnings
npm test --prefix vscode-control
python3 -m unittest discover -s tests -p 'test_*.py'
python3 vscode-control/scripts/browser_smoke.py
```

Rust process tests launch the real hook against a local mock API. They cover routing, exact saved originals, incomplete and failed batches, protected lines, malformed config, private hook status, and two simultaneous session IDs with separate settings and records. Node tests cover the control bridge, configuration and key validation, session path selection, bounded log reads, panel validation, and connection errors. The browser smoke test renders the actual composer and settings scripts in Edge at four widths and checks pending, healthy, and failed hook states. The panel harness renders the current version-3 batch view. Python tests validate trust inspection, the pinned Codex patch, documentation links, and default config values.

To exercise the installed hook, run `python3 scripts/check_hook_trust.py` after installation and after every update. Then start a new Codex thread and run a local command with more than 256 characters of ordinary text on an enabled route. The control should first show amber, then green after a hook invocation; a completed decision appears in this session's logs. A key test checks the API only.

An optional live Rust test uses `CODEX_JEV_LIVE_KEY_FILE=<private .env path>` and `cargo test -p codex-jev live_line_request_records_valid_independent_answers -- --ignored`. It makes real Jev requests using synthetic output and writes only to a temporary directory. The offline suite and live smoke test do not prove that every future judgment preserves every useful line; review real receipts with `jevctl evaluate-quality --cases <private JSON>` before changing cutoffs.
