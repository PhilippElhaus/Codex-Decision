# Tests

Run the current release checks from the repository root. The offline tests use synthetic tool output and Jev replies; they do not need an API key.

```bash
CARGO_TARGET_DIR="$HOME/.cache/codex-jev/cargo-target" cargo test -p codex-jev
CARGO_TARGET_DIR="$HOME/.cache/codex-jev/cargo-target" cargo clippy --all-targets -- -D warnings
npm test --prefix vscode-control
python3 -m unittest discover -s tests -p 'test_*.py'
python3 vscode-control/scripts/browser_smoke.py
```

Rust process tests launch the real hook against a local mock API. They cover routing, exact saved originals, incomplete and failed batches, Choice gate keep/filter/error paths, protected lines, malformed config, shared settings, private hook status, release versions, hook trust inspection, the pinned Codex webview patch, and two simultaneous session IDs with separate switches and records. Node tests cover the control bridge, shared settings without a thread, aggregated activity, one-time all-selected defaults, preserved per-session choices, configuration and key validation, bounded log reads, panel validation, and connection errors. The browser smoke test renders the actual composer and settings scripts in Edge at four widths and checks internal thread changes without a URL change, plus healthy and failed API states and home-screen settings. The panel harness renders the current version-3 batch view. Python tests validate documentation links and default config values.

To exercise the installed hook, run `jevctl check-hook-trust --cwd <repository>` after installation and after every update. Then start a new Codex thread and run a local command with more than 256 characters of ordinary text on an enabled route. The control should be green after the API check; a completed decision appears in this session's logs. A key test checks the API only.

Optional live Rust tests use `CODEX_JEV_LIVE_KEY_FILE=<private .env path>` and `cargo test -p codex-jev live_ -- --ignored`. They check the real line and Choice response shapes using synthetic output and write only to temporary directories. The offline suite and live smoke tests do not prove that every future judgment preserves every useful line; review real receipts with `jevctl evaluate-quality --cases <private JSON>` before changing cutoffs.
