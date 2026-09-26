# Verification

Run from the repository root. These checks use mock Jev replies and need no key:

```bash
python3 -m unittest discover -s tests -v
python3 scripts/benchmark_all_filters.py --mode mock --per-variant 100
npm --prefix vscode-control test
python3 -m unittest discover -s vscode-control/tests -p 'test_*.py' -v
python3 vscode-control/scripts/browser_smoke.py
```

For a live run, first set `CODEX_JEV_DATA_DIRECTORY` to a private plugin data directory with `.env`. Then run:

```bash
python3 scripts/benchmark_all_filters.py --mode live --rounds 3
```

The [benchmark report](../benchmarks/benchmark_live_2026-09-26.md) states the limits of its token counts.
