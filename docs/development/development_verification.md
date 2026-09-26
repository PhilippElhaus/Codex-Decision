# Verification

Run from the repository root. These checks do not need a Jev key or make Jev API calls:

```bash
python3 -m unittest discover -s tests -v
python3 scripts/replay.py --per-category 100
python3 scripts/benchmark_context.py
python3 scripts/benchmark_all_filters.py --mode mock --per-variant 100
npm --prefix vscode-control test
python3 -m unittest discover -s vscode-control/tests -p 'test_*.py' -v
python3 vscode-control/scripts/browser_smoke.py
```

The Python suite checks routing, sensitive-content gates, private `.env` loading, exact original recovery, and fail-open behavior. Its process tests mock the Jev HTTP response. Node tests check selection, health, statistics, and view resets. The Edge harness checks layout and selection at two widths.

The following runs make real Jev requests. Set `CODEX_JEV_DATA_DIRECTORY` to an installed plugin data directory containing your private `.env` first. Disposable runs copy the key into owner-only temporary plugin data and remove that directory afterward.

```bash
python3 scripts/live_test_build_smoke.py
python3 scripts/live_search_listing_smoke.py
python3 scripts/live_three_filter_samples.py
python3 scripts/measure_live.py --repetitions 5
python3 scripts/replay.py --live --per-category 3 --live-max-calls 30
python3 scripts/benchmark_all_filters.py --mode live --rounds 3
```

The three-filter sample can instead use an existing `--data-dir` to record outcomes in that installed plugin's history; saved originals then remain there. Both benchmark scripts use exact `o200k_base` counts when `tiktoken` is installed, otherwise a labeled four-characters-per-token proxy. These are context-size comparisons, not Codex billing or complete task measurements.

The [2026-09-26 benchmark report](../benchmarks/benchmark_live_2026-09-26.md) records a direct HTTPS run with the private `.env`. It links the earlier bridge report for historical comparison.
