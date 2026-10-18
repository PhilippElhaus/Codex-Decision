"use strict";
// Reviewed before the calibration trial. Use unknown command output shapes so
// these labels exercise the semantic gate instead of a local format contract.
// These fixtures and labels must not tune the gate or line cutoff.
const cases = [];
const all = lines => lines.map((_, index) => index + 1);
const add = (id, kind, task, lines, required, extra = {}) => cases.push({
  id: `classification-${id}`, kind, task, lines, required_lines: required,
  command: "node synthetic-calibration.cjs", split: "holdout",
  expected_classification_calls: 1, ...extra,
});

const events = Array.from({ length: 48 }, (_, index) => `Cycle ${index + 1}: replica health probe returned nominal`);
events[28] = "Cycle 29: observed upstream_delay_ms=731 for replica amber";
add("independent-events", "repetitive_log", "Find the replica with unusual upstream delay and report the measured value and final status.",
  [...events, "Run complete"], [29, 49], { safe_opportunity: true });
const progress = Array.from({ length: 48 }, (_, index) => `Transfer staging ${index + 1}/48; preparing next contiguous block`);
add("one-transfer", "progress_output", "Confirm whether the transfer completed and report the final digest.",
  [...progress, "Transfer complete; digest=synthetic-calibration-731"], [49], { safe_opportunity: true });
const hits = ["Search report for configured durations", ...Array.from({ length: 48 }, (_, index) =>
  `src/background/topic_${index + 1}.rs:12: duration_ms = 20`)];
hits[29] = "src/active/remote.rs:73: duration_ms = 731";
add("search-with-header", "independent_matches", "Locate the active remote source setting and report its duration.",
  hits, [30], { safe_opportunity: true });
const records = Array.from({ length: 48 }, (_, index) => `assets/calibration/background_${index + 1}.png`);
records[28] = "assets/calibration/network_timeout.svg";
add("inventory", "independent_records", "Locate the network timeout illustration.", records, [29], { safe_opportunity: true });

const measurements = Array.from({ length: 48 }, (_, index) => `Sample ${index + 1}: duration_ms=${index * 7 + 31}; observations=${index + 2}`);
add("distinct-measurements", "exact_content", "Compute the exact weighted mean duration using the observation counts.",
  measurements, all(measurements), { expect_full: true });
const prose = Array.from({ length: 32 }, (_, index) =>
  `Argument ${index + 1} follows from the preceding assumption and qualifies the next conclusion about ordering.`);
add("connected-reasoning", "prose", "Explain the reasoning while preserving its assumptions and qualifications.",
  prose, all(prose), { expect_full: true });
const csv = ["zone,bucket,count", ...Array.from({ length: 48 }, (_, index) => `zone_${index + 1},${index % 3},${index + 11}`)];
add("coupled-csv", "structured_payload", "Inspect this CSV table and preserve its machine readable structure.",
  csv, all(csv), { expect_full: true });
const mixed = [...events.slice(0, 24),
  "This apparent healthy result assumes that probes ran after the state transition.",
  "The preceding probe records alone cannot establish that ordering condition.",
  "A delayed transition can make the same records consistent with stale state.", ...events.slice(24), "Run complete"];
add("events-with-qualification", "mixed_or_unknown", "Explain the ordering limitation with the supporting probe records and preserve the qualification.",
  mixed, all(mixed), { expect_full: true });

module.exports = cases;
