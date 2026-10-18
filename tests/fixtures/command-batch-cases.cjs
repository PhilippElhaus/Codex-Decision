"use strict";

// Reviewed synthetic pairs for command adapters. These exercise the complete
// hook, including exact typed originals and rollback after completed batches.
const lines = [...Array.from({ length: 120 }, (_, index) => `INFO synthetic batch heartbeat ${index}`),
  "ERROR: synthetic batch connection refused at example.invalid:8443", "Done"];
lines[35] = "INFO observed worker_group=blue in synthetic batch runtime";
const command = output => ({ output, chunk_id: "synthetic-batch", exit_code: 1, wall_time_seconds: 0.01 });
const duplicate = value => ({ content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value, isError: false });
const settled = output => [0, 1].map(i => ({ i, status: "fulfilled", value: command(output) }));
const modelText = value => [{ type: "input_text", text: JSON.stringify(value) }];

function projectedBatch(output, withIndex = true) {
  let projected = 'Command result metadata: {"batch_format":"all_settled","batch_size":2}\n';
  for (const index of [0, 1]) {
    projected += `Command result metadata: {"batch_index":${index},"status":"fulfilled"${withIndex ? `,"i":${index}` : ""}}\n`;
    projected += 'Command result metadata: {"chunk_id":"synthetic-batch","exit_code":1,"wall_time_seconds":0.01}\n';
    projected += output + (output.endsWith("\n") ? "" : "\n");
  }
  return projected;
}

function projectedNumbers(sourceCount, numbers) {
  return [0, 1].flatMap(index => numbers.map(number => 3 + index * (sourceCount + 2) + number));
}

const required = [36, 121, 122];
const base = {
  kind: "repetitive_log", task: "Identify the observed worker group, the exact failed connection port, and completion status in both command results.",
  tool: "functions.exec", tool_input: { input: "const results=await Promise.allSettled(syntheticCommands); text(results.map((result,i)=>({i,...result})))" },
  command: "node synthetic-batch-worker.cjs", lines,
  response_factory: output => modelText(settled(output)), projection_factory: projectedBatch,
  required_lines: projectedNumbers(lines.length, required),
  routine_lines: projectedNumbers(lines.length, lines.map((_, index) => index + 1).filter(number => !required.includes(number))),
  safe_opportunity: true, expected_classification_calls: 0, expected_decision: true, min_batches: 2,
};

const cases = [
  { ...base, id: "coverage-command-batch-all-settled" },
  { ...base, id: "coverage-command-batch-all-settled-without-index",
    response_factory: output => modelText(settled(output).map(({ status, value }) => ({ status, value }))),
    projection_factory: output => projectedBatch(output, false) },
];

const recordProjection = (output, i) =>
  `Command result metadata: {"batch_format":"all_settled","batch_size":1}\n` +
  `Command result metadata: {"batch_index":0,"status":"fulfilled","i":${i}}\n` +
  'Command result metadata: {"chunk_id":"synthetic-batch","exit_code":1,"wall_time_seconds":0.01}\n' +
  output + (output.endsWith("\n") ? "" : "\n");
cases.push({ ...base, id: "coverage-command-batch-separate-settled-records",
  tool_input: { input: "const results=await Promise.allSettled(syntheticCommands); results.forEach((result,i)=>text({i,...result}))" },
  response_factory: output => settled(output).map(value => ({ type: "input_text", text: JSON.stringify(value) })),
  projection_factory: output => [0, 1].map(i => recordProjection(output, i)).join("\n"),
  required_lines: [0,1].flatMap(index => required.map(number => 3 + index * (lines.length + 4) + number)),
  routine_lines: [],
});

// Unsupported serialized shapes stay atomic. Their raw JSON remains one
// protected source line; no safe member is evaluated on its own.
for (const [suffix, change] of [
  ["unknown-member", batch => { batch[1].value.extra = "required unknown metadata"; }],
  ["rejected-member", batch => { batch[1] = { i: 1, status: "rejected", reason: "required synthetic failure" }; }],
  ["mismatched-duplicate", batch => {
    batch[1].value = duplicate(batch[1].value);
    batch[1].value.structuredContent.output = "different required evidence";
  }],
  ["mixed-media-member", batch => {
    batch[1].value = duplicate(batch[1].value);
    batch[1].value.content.push({ type: "image", data: "synthetic" });
  }],
  ["structured-member", batch => { batch[1].value.output = JSON.stringify({required:Array.from({length:20},(_,i)=>i+1)},null,2); }],
  ["connected-prose-member", batch => { batch[1].value.output = "This paragraph depends on the preceding explanation.\n".repeat(20); }],
]) {
  const value = output => { const batch = settled(output); change(batch); return batch; };
  cases.push({ ...base, id: `coverage-command-batch-${suffix}`, safe_opportunity: false, must_stay_local: true,
    response_factory: output => modelText(value(output)), projection_factory: output => JSON.stringify(value(output)),
    required_lines: [1], routine_lines: [], expected_calls: 0, expected_decision: false,
    expected_skip: "no_eligible_lines", min_batches: undefined, expect_full: true });
}

cases.push({ ...base, id: "coverage-command-batch-separate-unknown-record", safe_opportunity: false, must_stay_local: true,
  response_factory: output => {
    const batch=settled(output);batch[1].value.extra="required unknown metadata";
    return batch.map(value=>({type:"input_text",text:JSON.stringify(value)}));
  },
  required_lines: [], routine_lines: [], expected_calls: 0, expected_decision: false,
  expected_skip: "unsupported_result", min_batches: undefined, expect_full: true });

const sensitiveLines = [...lines, "password=synthetic-sentinel-only"];
cases.push({ ...base, id: "coverage-command-batch-sensitive-member", lines: sensitiveLines,
  safe_opportunity: false, must_stay_local: true,
  required_lines: projectedNumbers(sensitiveLines.length, [36, 121, 122, 123]), routine_lines: [],
  expected_calls: 0, expected_decision: false, expected_skip: "sensitive", min_batches: undefined, expect_full: true });

const faultLines = [...Array.from({ length: 400 }, (_, index) => `INFO synthetic rollback heartbeat ${index}`),
  "ERROR: synthetic rollback connection refused at example.invalid:8443", "Done"];
cases.push({ ...base, id: "coverage-command-batch-late-provider-failure", lines: faultLines,
  required_lines: projectedNumbers(faultLines.length, [401, 402]), routine_lines: [], safe_opportunity: false,
  fault: "line-late-http500", expect_error: true, expect_full: true, expected_decision: false, min_batches: undefined });

module.exports = cases;
