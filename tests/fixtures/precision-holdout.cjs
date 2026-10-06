"use strict";
// Fresh cases labeled before either reference or trial questions see them.
const cases = [];
const indices = lines => lines.map((_, index) => index + 1);
const add = (id, task, lines, required, extra = {}) => cases.push({
  id, task, lines, required_lines: required, kind: "repetitive_log",
  command: "printf synthetic-unseen", routine_lines: indices(lines).filter(number => !required.includes(number)), ...extra,
});
for (const index of [17, 89]) {
  const lines = Array.from({ length: 120 }, (_, n) => `test startup_poll_${n} ... ok`);
  lines[index] = "test cancels_delayed_work_when_stopping ... ok";
  lines.push("test result: ok. 120 passed; 0 failed");
  add(`semantic-passing-${index}`, "Confirm that delayed work is cancelled during shutdown, using the passing regression test and final test status.",
    lines, [index + 1, 121], { command: "cargo test" });
}
const named = Array.from({ length: 120 }, (_, n) => `test unrelated_timeout_poll_${n} ... ok`);
named[34] = "test connect_deadline ... ok";
named[78] = "test write_deadline ... ok";
named.push("test result: ok. 120 passed; 0 failed");
add("two-named-tests", "Confirm that both connect_deadline and write_deadline passed and that the run completed successfully.",
  named, [35, 79, 121], { command: "cargo test" });
const facts = [
  ["immutable-mount", "Explain why application state cannot be persisted and name the affected directory.",
    "INFO immutable mount at /synthetic/state prohibits persistence"],
  ["listener-value", "Give the configured listener address and its exact port.",
    "INFO configured listener: address=127.0.0.1 port=8443"],
  ["unicode-authority", "Report the authoritative worker name and its observed queue length.",
    "INFO authoritative worker=α_日本 queue_length=37"],
];
for (const [id, task, finding] of facts) {
  const lines = Array.from({ length: 120 }, (_, n) => `INFO routine background check ${n}`);
  lines[53] = finding;lines.push("Done");
  add(id, task, lines, [54, 121]);
}
const rows = Array.from({ length: 100 }, (_, n) => `docs/background/timeout_${n}.md:12:timeout_ms=1000`);
rows[32] = "src/connect.rs:71:connect_deadline_ms=4500";
rows[66] = "src/write.rs:83:write_deadline_ms=9000";
add("two-search-values", "Report both source locations and values for the connect and write deadlines.",
  rows, [33, 67], { command: "rg -n deadline src", kind: "independent_matches" });
const sequence = Array.from({ length: 80 }, (_, n) => `INFO event sequence_number=${n < 40 ? n : n + 1}`);
sequence.push("Done");
add("sequence-gap", "Inspect the event number sequence to identify any missing event number.", sequence, indices(sequence),
  { kind: "exact_content", expect_full: true });

// Acceptance reserve: labeled after freezing candidate E, before its trials.
for (const [size, index] of [[90, 11], [300, 255]]) {
  const lines = Array.from({length:size}, (_, n) => `test background_connect_deadline_${n} ... ok`);
  lines[index] = "test auth::rejects_missing_certificate ... ok";
  lines.push(`test result: ok. ${size} passed; 0 failed`);
  add(`acceptance-passing-${size}`, "Confirm that auth::rejects_missing_certificate passed and report the final test status.",
    lines, [index+1,size+1], {command:"cargo test"});
}
const acceptanceFacts = [
  ["median", "Compute the exact median and maximum measured latency for payment-worker.",
    [[6,"INFO payment-worker latency sample: 11 ms"], [38,"INFO payment-worker latency sample: 29 ms"], [72,"INFO payment-worker latency sample: 17 ms"]]],
  ["transition", "Give the memory limit and deployment revision before and after the configuration change.",
    [[19,"INFO before change: memory_limit=512MiB revision=aaa111"], [68,"INFO after change: memory_limit=768MiB revision=bbb222"]]],
  ["temporal-cause", "Identify the configuration change immediately preceding recovery, including both timestamps.",
    [[22,"INFO 10:07:15 routing changed to pool=backup"], [57,"INFO 10:07:19 service recovered after routing change"]]],
  ["unicode", "Report the selected worker's identifier, region, and exact observed backlog.",
    [[46,"INFO selected worker=β_東京 region=日本-east backlog=83"]]],
  ["artifact", "Report the Linux artifact's verified checksum and the associated revision.",
    [[31,"INFO verified Linux artifact sha256=abcdef0123456789 revision=ccc333"]]],
  ["retry-count", "Count successful retries for job=invoice and identify their attempt numbers.",
    [[10,"INFO job=invoice retry attempt=2 successful"], [30,"INFO job=invoice retry attempt=4 successful"], [60,"INFO job=invoice retry attempt=5 successful"]]],
];
for (const [id, task, evidence] of acceptanceFacts) {
  const lines=Array.from({length:100},(_, n)=>`INFO routine background poll ${n}`);
  for (const [index,text] of evidence) lines[index]=text;
  lines.push("Done");
  add(`acceptance-${id}`,task,lines,[...evidence.map(([index])=>index+1),101]);
}
const acceptanceTests=Array.from({length:150},(_, n)=>`test cache_poll_${n} ... ok`);
acceptanceTests[41]="test cache::keeps_dirty_entries ... ok";
acceptanceTests[115]="test cache::expires_clean_entries ... ok";
acceptanceTests.push("test result: ok. 150 passed; 0 failed");
add("acceptance-two-tests", "Confirm that cache::keeps_dirty_entries and cache::expires_clean_entries both passed and give the run's final status.",
  acceptanceTests,[42,116,151],{command:"cargo test"});
const acceptanceSearch=Array.from({length:100},(_, n)=>`docs/defaults_${n}.md:12:read_buffer_bytes=4096`);
acceptanceSearch[26]="src/client.rs:63:read_buffer_bytes=8192";
acceptanceSearch[74]="src/server.rs:87:write_buffer_bytes=16384";
add("acceptance-two-buffer-values", "Give the client read-buffer and server write-buffer values, with their source locations.",
  acceptanceSearch,[27,75],{command:"rg -n buffer_bytes src",kind:"independent_matches"});
module.exports = cases;
