"use strict";
// Required findings and routine events are labeled before live evaluation.
const cases = [];
const all = lines => lines.map((_, index) => index + 1);
const add = (id, task, lines, required, extra = {}) => cases.push({
  id, task, lines, required_lines: required, kind: "repetitive_log",
  command: "printf synthetic-precision", ...extra,
});
const noise = n => Array.from({ length: n }, (_, index) => `INFO routine background poll ${index}`);
const prefix = "Inspect the synthetic observations and preserve the required findings. ".repeat(12);
const log = [...noise(60), "Done"];
add("late-exhaustive-task", prefix + "Return every record verbatim.", log, all(log),
  { kind: "exact_content", expect_full: true, expected_calls: 0 });
const finding = [...noise(120), "Done"];
finding[47] = "INFO primary endpoint = primary.example.invalid:8443";
finding[82] = "INFO fallback endpoint = fallback.example.invalid:9443";
add("late-specific-task", prefix + "Report the exact primary and fallback endpoint hostnames and ports.",
  finding, [48, 83, 121], { routine_lines: all(finding).filter(number => ![48, 83, 121].includes(number)) });
for (const [id, command] of [
  ["extensionless-cat", "cat Config"],
  ["extensionless-head", "head -n 60 Config"],
  ["extensionless-tail", "tail -n 60 Config"],
  ["extensionless-sed", "sed -n '1,60p' Config"],
  ["mixed-file-operands", "cat progress.log Config"],
]) add(id, "Inspect the configuration rows.", log, all(log),
  { command, kind: "exact_content", expect_full: true, expected_calls: 0 });
const diff = ["diff --git a/Config b/Config", "--- a/Config", "+++ b/Config", "@@ -1,60 +1,60 @@",
  ...noise(60).map(line => "-" + line), ...noise(60).map(line => "+" + line)];
for (const [id, command] of [["diff-stat-patch", "git diff --stat --patch"], ["show-stat-patch", "git show --stat -p"]]) {
  add(id, "Inspect the changed configuration rows.", diff, all(diff),
    { command, kind: "exact_content", expect_full: true, expected_calls: 0 });
}
for (const index of [4, 29, 68, 101]) {
  const lines = Array.from({ length: 120 }, (_, n) => `test background_poll_${n} ... ok`);
  lines[index] = "test timeout_on_shutdown ... ok";
  lines.push("test result: ok. 120 passed; 0 failed");
  add(`named-passing-test-${index}`, "Confirm that timeout_on_shutdown passed and that the test run completed successfully.",
    lines, [index + 1, 121], { command: "cargo test", routine_lines: all(lines).filter(number => ![index + 1, 121].includes(number)) });
}
const measurements = Array.from({ length: 60 }, (_, index) => `INFO latency sample ${index}: ${(index * 17) % 97 + 1} ms`);
measurements.push("Done");
add("aggregate-median", "Calculate the exact median latency from the observations.", measurements, all(measurements),
  { kind: "exact_content", expect_full: true });
const provenance = [...noise(120), "Done"];
provenance[39] = "INFO active deployment: revision a1b2c3d; artifact sha256 0123456789abcdef";
provenance[72] = "INFO rollback target: revision d4e5f6a; artifact sha256 fedcba9876543210";
add("two-provenance-values", "Report both the active and rollback revisions with their artifact digests.", provenance,
  [40, 73, 121], { routine_lines: all(provenance).filter(number => ![40, 73, 121].includes(number)) });
for (const [id, latest_content] of [
  ["empty-latest-user", []],
  ["image-only-latest-user", [{ type: "input_image", image_url: "https://synthetic.invalid/image.png" }]],
]) add(id, "", log, all(log), { prior_task: "Confirm the build succeeded.", latest_content,
  kind: "exact_content", expect_full: true, expected_calls: 0 });
for (const [id, part] of [
  ["partial-latest-text-number", {type:"input_text",text:17}],
  ["partial-latest-text-null", {type:"input_text",text:null}],
  ["partial-latest-text-missing", {type:"input_text"}],
]) add(id, "", log, all(log), {
  latest_content:[{type:"input_text",text:"Inspect the observations."},part],
  kind:"exact_content",expect_full:true,expected_calls:0,
});
add("duplicate-enabled-config", "Confirm the build succeeded.", log, all(log), {
  kind:"exact_content", expect_full:true, expected_calls:0,
  config_raw:'{"schema_version":4,"scope":"global","enabled":false,"enabled":true,"mode":"replace","model":"jev-latest","timeout_seconds":4,"relevance_policy":{"relevant_max":5}}',
});
for (const [id, task] of [
  ["install-paths-boundary", "Identify failing install paths."],
  ["small-values-boundary", "Report the small values relevant to this setting."],
]) add(id, task, [...noise(60), "ERROR failed setting: retry_ms=7", "Done"], [61,62], {
  expected_calls:1,
});
for (const [id, extra] of [
  ["read-extensionless-source", {tool:"Read",tool_input:{file_path:"Config"}}],
  ["mcp-read-extensionless-source", {tool:"mcp__files__read_file",tool_input:{path:"Config"}}],
  ["heredoc-source", {command:"cat <<'EOF'\n" + log.join("\n") + "\nEOF"}],
]) add(id, "Inspect the configuration rows.", log, all(log), {
  ...extra, kind:"exact_content", expect_full:true, expected_calls:0,
});
add("read-explicit-log", "Identify the failed setting in the log.",
  [...noise(60), "ERROR failed setting: retry_ms=7", "Done"], [61,62], {
    tool:"Read", tool_input:{file_path:"service.log"}, expected_calls:1,
  });
module.exports = cases;
