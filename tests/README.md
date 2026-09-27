# Tests

Run tests from the repository root. The default checks use synthetic Jev replies and temporary data outside `D:\`. They do not need an API key.

| Directory | Purpose | Main coverage |
| --- | --- | --- |
| `unit/` | Local decisions and configuration | Output safety gates, threshold boundaries, VS Code config and log helpers. |
| `integration/` | Contracts between components | Test/build and search routing, Python/Node defaults, VS Code bridge, patch and rollback. |
| `e2e/` | Hook entry point | All three filters through a process-level Jev mock; oversize and outage behavior. |
| `browser/` | Browser fixtures | Composer control, settings, key overlay, responsive layout, and documentation captures. |
| `edge/` | Invalid inputs | Malformed config, unsafe credential files, invalid Jev answers, receipt links, retention boundaries, and concurrent log writes. |
| `load/` | Bounded large inputs | Large-output replay, benchmark accounting, and multi-batch decision logs. |
| `smoke/` | Small launch checks | Disabled, malformed, and short events through the command hook; local documentation links. |

## Fast checks

```bash
python3 -m unittest discover -s tests/smoke -p 'test_*.py' -v
python3 -m unittest discover -s tests/unit -p 'test_*.py' -v
python3 -m unittest discover -s tests/edge -p 'test_*.py' -v
npm --prefix vscode-control test
```

## Full offline check

```bash
python3 -m unittest discover -s tests -p 'test_*.py' -v
npm --prefix vscode-control test
python3 vscode-control/scripts/browser_smoke.py
python3 scripts/benchmark_all_filters.py --mode mock --per-variant 100
```

The browser smoke test runs the real webview scripts with a synthetic VS Code bridge. It checks the TypeSafe link click, browser-launch error, the checked log-retention tick and persistence, failed-save recovery, method controls, percentage boundaries, saved-key mask length, Reset defaults alignment, and layouts at 360, 720, and 1200 pixels in Microsoft Edge. The Node bridge test checks that the fixed TypeSafe URL is sent to VS Code's external browser API. Process-level tests check one receipt per Jev request and exact output for every chunk. Edge tests check permissions, pruning, symlink preservation, and concurrent event writes. Browser smoke needs Windows Edge and `pwsh.exe` available from WSL. Python and Node tests can run without the browser.

The mock benchmark checks all three routes. Its result is a test fixture, not a live performance claim. The dated live benchmark in `docs/benchmarks/` is separate from the offline suite.

When changing a cutoff or mode, run the defaults contract and boundary tests. When changing hook routing, run the process-level tests and browser smoke test. When changing the pinned Codex patch, run the patch and rollback tests before installation.
