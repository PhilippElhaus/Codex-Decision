"use strict";
// Reviewed synthetic gate probes. Positive expectations require evaluation;
// paired local-only controls retain the evidence and privacy boundaries.
const cases = [];
const all = lines => lines.map((_, index) => index + 1);
const routine = Array.from({length:40}, (_, index) => `INFO synthetic cache heartbeat ${index + 1}`);
const log = [...routine, "ERROR: synthetic connection refused at example.invalid:8443", "Done"];
const base = {kind:"repetitive_log", task:"Find the connection failure and preserve its exact port and final status.",
  command:"node synthetic-worker.cjs", lines:log, required_lines:[41,42]};
const skip = reason => ({expect_full:true, expected_calls:0, expected_skip:reason});
const evaluated = {expected_decision:true, expected_calls:1, expected_classification_calls:0};

// A diagnostic word inside a healthy metric or a passing test name currently
// protects the entire output. The paired failures require complete retention.
const counters = [...Array.from({length:40}, (_, index) => `INFO error_count=0 synthetic heartbeat ${index + 1}`), "Done"];
cases.push({...base, id:"coverage-metric-diagnostic-word", coverage_pair:"diagnostic-metric",
  task:"Confirm the final run status; routine healthy heartbeats do not need to be repeated.",
  lines:counters, required_lines:[41], safe_opportunity:true, ...evaluated});
const diagnostics = [...Array.from({length:40}, (_, index) => `ERROR: synthetic worker ${index + 1} rejected request with cause code ${index + 100}`), "Done"];
cases.push({...base, id:"coverage-real-diagnostic-records", coverage_pair:"diagnostic-metric",
  task:"Explain the worker rejections using the recorded cause codes and final status.",
  lines:diagnostics, required_lines:all(diagnostics), must_stay_local:true, ...skip("no_eligible_lines")});
const passing = [...Array.from({length:40}, (_, index) => `test synthetic::handles_error_${index + 1} ... ok`),
  "test result: ok. 40 passed; 0 failed"];
cases.push({...base, id:"coverage-passing-test-diagnostic-word", coverage_pair:"diagnostic-test-name",
  command:"cargo test", task:"Confirm the test run succeeded; passing test names are routine context.",
  lines:passing, required_lines:[41], safe_opportunity:true, ...evaluated});
const failing = [...Array.from({length:40}, (_, index) => `test synthetic::handles_input_${index + 1} ... FAILED`),
  "test result: FAILED. 0 passed; 40 failed"];
cases.push({...base, id:"coverage-real-failing-test-records", coverage_pair:"diagnostic-test-name",
  command:"cargo test", task:"Identify the failing tests and preserve the final totals.",
  lines:failing, required_lines:all(failing), must_stay_local:true, ...skip("no_eligible_lines")});

// These read-only operation names contain mutation vocabulary. The synthetic
// MCP policy is enabled here to isolate name routing from replacement policy.
// Future support needs an explicitly validated read-only tool contract.
for (const [suffix, action, unsafeAction] of [
  ["commit-history", "list_commits", "commit"],
  ["deployment-status", "get_deployment_status", "deploy"],
  ["merge-conflicts", "lookup_merge_conflicts", "merge"],
]) {
  cases.push({...base, id:`coverage-readonly-${suffix}`, coverage_pair:`route-${suffix}`,
    tool:`mcp__synthetic__${action}`, tool_input:{query:"synthetic status log"}, allow_mcp_replacement:true,
    safe_opportunity:true, ...evaluated});
  cases.push({...base, id:`coverage-mutating-${suffix}`, coverage_pair:`route-${suffix}`,
    tool:`mcp__synthetic__${unsafeAction}`, tool_input:{target:"synthetic-only"}, allow_mcp_replacement:true,
    required_lines:all(log), must_stay_local:true, ...skip("unsupported_route")});
}
cases.push({...base, id:"coverage-readonly-mcp-policy-control",
  tool:"mcp__synthetic__list_commits", tool_input:{query:"synthetic status log"},
  allow_mcp_replacement:false, must_stay_local:true, ...skip("mcp_replacement_disabled")});

// A valid numeric or Boolean filename is also a JSON scalar. The current
// structure guard checks that ambiguity before the command's path contract.
const paths = Array.from({length:40}, (_, index) => `src/synthetic/module_${index + 1}.rs`);
paths[19] = "src/network/timeout_config.rs";
for (const scalar of ["123", "true"]) {
  const lines = [scalar, ...paths];
  cases.push({...base, id:`coverage-scalar-filename-${scalar}`, coverage_pair:"scalar-path",
    kind:"independent_records", command:"rg --files", lines, required_lines:[21],
    task:"Locate the network timeout configuration file.", safe_opportunity:true, ...evaluated});
}
cases.push({...base, id:"coverage-ordinary-filename-control", coverage_pair:"scalar-path",
  kind:"independent_records", command:"rg --files", lines:["README.md", ...paths], required_lines:[21],
  task:"Locate the network timeout configuration file.", safe_opportunity:true,
  expected_decision:true, expected_calls:1, expected_classification_calls:0});
const structured = JSON.stringify({synthetic:true, records:Array.from({length:25}, (_, index) => ({id:index,value:index * 7}))}, null, 2).split("\n");
cases.push({...base, id:"coverage-structured-payload-control", coverage_pair:"scalar-path",
  kind:"structured_payload", command:"node synthetic-export.cjs", lines:structured, required_lines:all(structured),
  task:"Inspect the synthetic structured payload and its record relationships.",
  must_stay_local:true, ...skip("structure_guard")});

// Explicit rotated and upper-case log names remain exact source reads today.
// The paired source file has identical log-shaped text but must stay exact.
for (const filename of ["worker.LOG", "worker.log.1"]) {
  cases.push({...base, id:`coverage-explicit-log-${filename === "worker.LOG" ? "uppercase" : "rotated"}`,
    coverage_pair:"explicit-log-suffix", command:`cat ${filename}`, safe_opportunity:true,
    ...evaluated});
}
cases.push({...base, id:"coverage-explicit-log-control", coverage_pair:"explicit-log-suffix",
  command:"cat worker.log", safe_opportunity:true, expected_decision:true, expected_calls:1,
  expected_classification_calls:0});
cases.push({...base, id:"coverage-log-shaped-source-control", coverage_pair:"explicit-log-suffix",
  command:"cat synthetic.conf", required_lines:all(log), must_stay_local:true, ...skip("exact_content")});

module.exports = cases;
