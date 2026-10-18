"use strict";
// Workload-shaped, reviewed synthetic holdout. Every supported wrapper uses the
// same evidence, so routing coverage is comparable across host tool boundaries.
const lines = [...Array.from({ length: 80 }, (_, index) => `INFO routine worker heartbeat ${index}`),
  "ERROR: synthetic connection refused at example.invalid:8443", "Done"];
lines[24] = "INFO observed worker_group=blue in synthetic worker runtime";
const payload = output => ({ output, exit_code: 1, wall_time_seconds: 0.01, chunk_id: "synthetic" });
const projected = output => `Command result metadata: ${JSON.stringify({chunk_id:"synthetic",exit_code:1,wall_time_seconds:0.01})}\n${output}`;
const base = { kind: "repetitive_log", task: "Identify the observed worker group, the connection failure, its exact port, and the final completion status.",
  command: "node synthetic-worker.cjs", lines, required_lines: [25, 81, 82],
  routine_lines: lines.map((_,index)=>index+1).filter(number=>![25,81,82].includes(number)), safe_opportunity: true,
  expected_calls: 1, expected_classification_calls: 0, expected_decision: true };
const shellWrapper = { ...base, tool: "functions.exec", tool_input: {input:"text(await tools.exec_command({cmd:'node synthetic-worker.cjs'}))"},
  response_factory: output => [{type:"input_text",text:JSON.stringify(payload(output))}],
  projection_factory: projected, required_offset: 1 };
const cases = [
  { ...base, id: "coverage-shell-log" },
  { ...shellWrapper, id: "coverage-code-mode-exec-log" },
  { ...shellWrapper, id: "coverage-code-mode-wait-log", tool: "functions.wait", tool_input: {cell_id:"synthetic-cell"} },
  { ...base, id: "coverage-shell-command-envelope", tool: "exec_command", tool_input: {cmd:base.command},
    response_factory: payload, projection_factory: projected, required_offset: 1 },
  { ...base, id: "coverage-duplicated-structured-command", tool:"exec_command", tool_input:{cmd:base.command},
    response_factory: output => ({content:[{type:"text",text:JSON.stringify(payload(output))}],structuredContent:payload(output)}),
    projection_factory: projected, required_offset:1 },
  { ...base, id: "coverage-serialized-command-batch", tool:"exec", tool_input:{input:"text(await Promise.all(syntheticCommands))"},
    response_factory: output => [{type:"input_text",text:JSON.stringify([payload(output),payload(output)])}],
    projection_factory: output => 'Command result metadata: {"batch_format":"array","batch_size":2}\n' +
      [0,1].map(index => `Command result metadata: {"batch_index":${index}}\n${projected(output)}`).join(''),
    required_lines:[28,84,85,112,168,169], routine_lines:[], expected_calls:undefined, min_batches:2 },
  { ...base, id: "coverage-sensitive-control", safe_opportunity: false, must_stay_local: true,
    lines: [...lines,"password=synthetic-sentinel-only"], required_lines:[81,82,83],
    expected_calls: 0, expected_decision: false, expected_skip:"sensitive", expect_full:true },
  { ...shellWrapper, id: "coverage-mixed-media-control", safe_opportunity: false, must_stay_local: true,
    response_factory: output => [{type:"input_text",text:JSON.stringify(payload(output))},{type:"input_image",image_url:"synthetic"}],
    expected_calls: 0, expected_decision: false, expected_skip:"unsupported_result", expect_full:true },
  { ...base, id: "coverage-disabled-control", enabled: false, safe_opportunity: false,
    expected_calls: 0, expected_decision: false, expect_full:true },
  { ...base, id:"coverage-insufficient-savings-control", lines:["INFO routine heartbeat "+"x".repeat(270),"Done"],
    required_lines:[2], safe_opportunity:false, must_stay_local:true, expected_calls:0,
    expected_decision:false, expected_skip:"insufficient_savings", expect_full:true },
];
const existing = require("./two-stage-cases.cjs");
for (const id of ["connected-prose","small-output","lab-execute-supported","lab-wait-supported","lab-wrapper-log"]) {
  const item = existing.find(item => item.id === id);
  if (!item) throw new Error(`Missing reviewed coverage fixture: ${id}`);
  cases.push({...item,id:`coverage-${id}`,
    ... (id === "connected-prose" ? {expected_calls:1,expected_classification_calls:1,expected_relevance_calls:0} :
      id === "small-output" ? {must_stay_local:true} : {safe_opportunity:true})});
}
module.exports = [...cases, ...require("./coverage-gate-holdout.cjs"), ...require("./command-batch-cases.cjs")];
