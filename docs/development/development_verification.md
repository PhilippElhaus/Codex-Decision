# Verification

Run commands from the repository root. [The test map](../../tests/README.md) shows each suite and its coverage. Default tests use synthetic replies and need no API key.

## Fast checks

```bash
python3 -m unittest discover -s tests/smoke -p 'test_*.py' -v
python3 -m unittest discover -s tests/unit -p 'test_*.py' -v
python3 -m unittest discover -s tests/edge -p 'test_*.py' -v
npm --prefix vscode-control test
```

## Before delivery

```bash
python3 -m unittest discover -s tests -p 'test_*.py' -v
npm --prefix vscode-control test
python3 vscode-control/scripts/browser_smoke.py
python3 scripts/benchmark_all_filters.py --mode mock --per-variant 100
git diff --check
```

The Python suite includes process-level hook tests and the pinned Codex patch's apply, update, tamper, and restore tests. The Node suite includes the VS Code bridge, error handling, and a multi-batch log load test. The Edge browser smoke test checks the composer, key overlay, and settings form at three widths with mock data. It needs Windows Edge and `pwsh.exe` in WSL.

The mock benchmark verifies routing and preservation rules. Do not use it as a live speed or token-savings measurement. The [dated benchmark report](../benchmarks/benchmark_live_2026-09-26.md) explains the live measurement and its limits.

For filter logic changes, add reviewed cases for [quality replay](../../scripts/evaluate_quality.py). Label whether each result is safe to shorten and which exact fragments the agent needs. Add paired full-task outcomes when available. The tool reports a held-out risk bound before it suggests stricter thresholds. Do not apply a suggested cutoff from a small or unrepresentative set. Run process-level hook tests after changing a request, output format, or chunk schedule.
