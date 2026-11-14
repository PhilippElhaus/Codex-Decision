# Performance and concurrency checks

Use synthetic data and separate build directories when comparing revisions. Compare correctness before timing. Keep reports under `.local/quality/`.

## CPU and allocation measurements

```bash
cargo bench --locked -p codex-decision --bench pipeline -- all
cargo bench --locked -p codex-decision --bench pipeline -- equivalence
```

The equivalence mode emits packing fingerprints. Give before and after builds different `CARGO_TARGET_DIR` paths. Compare fingerprints before interpreting CPU or allocation changes. A local benchmark does not measure provider latency, delivered context, or cost.

## Concurrent hook processes

Build the synthetic verification runtime, then run:

```bash
cargo build --locked -p codex-decision --profile verification
node scripts/pipeline_stress.cjs --hook .cache/cargo/verification/decision-hook \
  --rounds 32 --concurrency 4 --out .local/quality/stress-review
```

The runner uses loopback providers and synthetic credentials. It verifies exact readable and typed originals, completed panels, counters, deliberate failures, and managed-log bounds. Use `--provider typesafe` for the second wire format. Use `--faults http,json,oversize,probability,model,timeout` to rotate failures. Use `--jitter-ms 20` for response timing variation and `--minutes 45` for a timed run. Choose a new report directory for every run.

Unexpected deadlines, lost telemetry, and mock failures fail the run. Request and invocation deadline recovery are covered by the native process tests. Production packaging never ships the verification runtime.

Publication and interruption checks are in [evaluation](evaluation.md). Browser endurance checks are in [browser validation](browser.md). Provider and downstream cost limits are in [measurement](../operations/measurement.md).
