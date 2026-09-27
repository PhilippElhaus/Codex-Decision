# Filter change verification, 2026-09-27

The baseline and updated code ran the same offline mock command:

```bash
python3 scripts/benchmark_all_filters.py --mode mock --per-variant 100
```

| Measure | Before | After |
| --- | ---: | ---: |
| Cases | 2,104 | 2,104 |
| Mock Jev calls | 1,100 | 1,100 |
| Synthetic label mismatches | 0 | 0 |
| Estimated tokens saved (characters / 4) | 995,048 | 1,011,248 |
| Reduction across all results | 15.8% | 16.1% |

The after run also passed 119 Python tests, 22 Node tests, and the browser smoke test at 360, 720, and 1200 pixels. A separate paired local loop of 300 ordinary, approved 400-line outputs measured 4.04 ms median for the previous source and 4.12 ms for the updated source. This loop excludes the Jev HTTP request. Its difference is small beside the network call, but it is not a claim of zero overhead.

The mock labels check routing and preservation rules. They do not measure Jev judgment accuracy, token billing, agent solve rate, or production latency. The [2026-09-26 live benchmark](benchmark_live_2026-09-26.md) measures an earlier implementation and must not be presented as a live measurement of this change. Use reviewed cases and paired full tasks with [the quality tool](../../scripts/evaluate_quality.py) before changing production thresholds.
