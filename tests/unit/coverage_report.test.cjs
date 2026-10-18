"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { caseCoverage, summarizeCoverage, classificationEvidence } = require("../../scripts/two-stage/coverage_report.cjs");

function run(extra = {}) {
  const source = "INFO routine\nrequired value=7\nDone\n";
  const input = { item: {safe_opportunity:true}, tool:"functions.exec", source, visible:source,
    toolResponse:source, calls:0, stages:[], receipt:null, activity:null, health:{}, replaced:false,
    originalExact:null, envelopeExact:null, requiredLines:[2,3], requiredLost:[], proposedRequiredLost:[], ...extra };
  return {coverage:caseCoverage(input)};
}
const receipt = (source, status = "replace") => ({initial_output:source,
  manifest:{status,choice_gate_ran:true}, decisions:[
    {number:1,action:"omit",p_task_relevant:0.01},
    {number:2,action:"keep",p_task_relevant:0.99},
    {number:3,action:"keep",protected_reason:"final_status"},
  ]});

test("participation counts outputs once and excludes deliberate fault and disabled controls", () => {
  const reports = [run({calls:3,stages:["classification","relevance","relevance"]}),
    run({health:{last_skip:"small"}}),
    run({item:{fault:"line-http500"},calls:1,health:{last_error:"request failed",request_failures:1}}),
    run({item:{enabled:false}})];
  const summary = summarizeCoverage(reports);
  assert.equal(summary.measurement,"offline_mock_routing_only");
  assert.equal(summary.workload.outputs,2);
  assert.equal(summary.workload.outputs_reaching_proxy,1);
  assert.equal(summary.workload.proxy_requests,3);
  assert.equal(summary.workload.proxy_participation_percent,50);
  assert.equal(summary.workload.labeled_safe_opportunity_participation_percent,50);
  assert.equal(summary.workload.missed_safe_opportunities,1);
  assert.equal(summary.by_skip_reason.small.local_skips,1);
  assert.equal(summary.by_size_band.under_256.outputs,2);
  assert.equal(summary.fault_controls.hook_error_outputs,1);
  assert.equal(summary.fault_controls.failed_request_attempts,1);
  assert.equal(summary.disabled_controls.outputs,1);
  assert.equal(summary.delivered_savings_bytes,null);
  assert.equal(summary.workload.outputs_forwarded_to_provider,null);
});

test("a validated classification keep reaches evaluation while retaining the full output", () => {
  const summary = summarizeCoverage([run({calls:1,stages:["classification"],
    health:{last_skip:"choice_kept_full_output",counter_scheme:1,responses_validated:1},
    activity:{classification:{choice:"prose"}}})]).workload;
  assert.equal(summary.outputs_reaching_proxy,1);
  assert.equal(summary.outputs_with_validated_classification,1);
  assert.equal(summary.classification_keeps,1);
  assert.equal(summary.post_request_skips,1);
  assert.equal(summary.completed_line_evaluations,0);
  assert.equal(summary.replacements_prepared,0);
  assert.equal(summary.hook_saved_bytes,0);
});

test("byte savings include projected metadata and count UTF-8 bytes", () => {
  const source = 'Command result metadata: {"exit_code":1}\nλ日本\n';
  const visible = "λ\n";
  const summary = summarizeCoverage([run({source,visible,toolResponse:{output:"λ日本\n",exit_code:1},
    calls:2,stages:["classification","relevance"],receipt:receipt(source),replaced:true,
    originalExact:true,envelopeExact:true})]).workload;
  assert.equal(summary.source_projection_bytes,Buffer.byteLength(source));
  assert.equal(summary.hook_saved_bytes,Buffer.byteLength(source)-Buffer.byteLength(visible));
  assert.equal(summary.kept_projection_bytes,Buffer.byteLength(visible));
  assert.equal(summary.source_byte_participation_percent,100);
  assert.equal(summary.unverified_replacement_originals,0);
  assert.equal(summarizeCoverage([run({source,visible,receipt:receipt(source),replaced:true,
    originalExact:false})]).workload.unverified_replacement_originals,1);
});

test("previews expose proposed evidence loss without recording actual loss or savings", () => {
  const source = "INFO routine\nrequired value=7\nDone\n";
  const summary = summarizeCoverage([run({source,receipt:receipt(source,"candidate"),calls:2,
    stages:["classification","relevance"],proposedRequiredLost:[2]})]).workload;
  assert.equal(summary.candidate_previews,1);
  assert.equal(summary.completed_line_evaluations,1);
  assert.equal(summary.proposed_required_lines_lost,1);
  assert.equal(summary.required_lines_lost,0);
  assert.equal(summary.hook_saved_bytes,0);
  assert.equal(summary.required_lines_in_replacements,0);
  assert.equal(summary.actual_required_line_loss_in_replacements_percent,null);
  assert.equal(summary.proposed_required_line_loss_in_completed_decisions_percent,50);
});

test("safety exposure separates judged, protected, completed and unchanged source labels", () => {
  const source = "INFO routine\nrequired value=7\nDone\n";
  const summary = summarizeCoverage([run({source,receipt:receipt(source),calls:2,replaced:true,
    stages:["classification","relevance"],originalExact:true}),
    run({requiredLines:Array.from({length:100},(_,index)=>index+1),health:{last_skip:"exact_content"}})]).workload;
  assert.equal(summary.required_lines,102);
  assert.equal(summary.required_lines_in_completed_decisions,2);
  assert.equal(summary.required_lines_model_judged,1);
  assert.equal(summary.required_lines_protected,1);
  assert.equal(summary.required_lines_in_replacements,2);
  assert.equal(summary.required_lines_model_judged_in_replacements,1);
  assert.equal(summary.required_lines_protected_in_replacements,1);
  assert.equal(summary.actual_required_line_loss_in_replacements_percent,0);
});

test("live forwarding, provider responses and successful classification remain separate", () => {
  const summary = summarizeCoverage([run({calls:1,stages:["classification"],
    health:{last_error:"proxy budget"}}),
    run({calls:1,forwardedCalls:1,providerResponses:1,stages:["classification"],
      health:{counter_scheme:1,responses_validated:0,request_failures:1,last_error:"invalid answer"}})],{live:true}).workload;
  assert.equal(summary.outputs_reaching_proxy,2);
  assert.equal(summary.outputs_forwarded_to_provider,1);
  assert.equal(summary.outputs_with_provider_response,1);
  assert.equal(summary.outputs_with_validated_classification,0);
  assert.equal(summary.proxy_participation_percent,100);
  assert.equal(summary.provider_forwarded_participation_percent,50);
  assert.equal(summary.labeled_safe_opportunity_provider_participation_percent,50);
  assert.equal(summary.hook_error_outputs,2);
});

test("local-only controls flag requests and empty denominators remain unknown", () => {
  const summary = summarizeCoverage([run({item:{must_stay_local:true},tool:"mcp__synthetic__read_log",calls:1})]);
  assert.equal(summary.workload.must_stay_local_request_violations,1);
  assert.equal(summary.by_tool_family.other_mcp.outputs,1);
  assert.equal(summary.workload.labeled_safe_opportunity_participation_percent,null);
  const empty = summarizeCoverage([]).workload;
  assert.equal(empty.proxy_participation_percent,null);
  assert.equal(empty.source_byte_participation_percent,null);
  assert.equal(empty.hook_byte_reduction_percent,null);
});

const kinds = ["repetitive_log", "progress_output", "independent_matches", "independent_records",
  "exact_content", "prose", "structured_payload", "mixed_or_unknown"];
const answer = (choice, probabilities, confidence = 0.99) => ({type:"choice",choice,confidence,
  probabilities:Object.fromEntries(kinds.map(kind => [kind, probabilities[kind] || 0]))});

test("combined excerptable probability uses the same gate regardless of class confidence", () => {
  const value=answer("repetitive_log",{repetitive_log:0.5,progress_output:0.46,prose:0.04},0.5);
  const evidence=classificationEvidence(value);
  assert.equal(evidence.combined_excerptable_probability,0.96);
  assert.equal(evidence.selected_confidence,0.5);
  assert.equal(evidence.gate_passes,true);
  const wire={...value,probabilities:Object.entries(value.probabilities).map(([value,probability])=>({value,probability}))};
  assert.deepEqual(classificationEvidence(wire),evidence);
  assert.equal(classificationEvidence(answer("repetitive_log",{repetitive_log:0.6,progress_output:0.34,prose:0.06})).gate_passes,false);
  assert.equal(classificationEvidence({...wire,probabilities:[...wire.probabilities.slice(0,-1),wire.probabilities[0]]}),null);
  assert.equal(classificationEvidence({...wire,probabilities:[null,...wire.probabilities.slice(1)]}),null);
  assert.equal(classificationEvidence(answer("prose",{repetitive_log:0.98,prose:0.02})),null);
  assert.equal(classificationEvidence(answer("prose",{prose:0.5})),null);
});

function classified(kind, classification, {keep=false,split="holdout"}={}) {
  return run({item:{kind,split},calls:keep ? 1 : 2,stages:keep ? ["classification"] : ["classification","relevance"],
    classification,health:{counter_scheme:1,responses_validated:keep ? 1 : 2,
      ...(keep ? {last_skip:"choice_kept_full_output"} : {})}});
}

test("held-out calibration measures misses and false positives with actual keep reasons", () => {
  const reports=[
    classified("repetitive_log",answer("repetitive_log",{repetitive_log:0.5,progress_output:0.46,prose:0.04},0.5)),
    classified("repetitive_log",answer("repetitive_log",{repetitive_log:0.6,progress_output:0.34,prose:0.06}),{keep:true}),
    classified("prose",answer("prose",{repetitive_log:0.04,prose:0.96}),{keep:true}),
    classified("prose",answer("repetitive_log",{repetitive_log:0.98,prose:0.02})),
    classified("repetitive_log",answer("repetitive_log",{repetitive_log:0.98,prose:0.02}),{split:"train"}),
  ];
  const calibration=summarizeCoverage(reports).classification_calibration;
  assert.equal(calibration.gate_minimum_combined_excerptable_probability,0.95);
  assert.equal(calibration.heldout.outputs,4);
  assert.equal(calibration.by_label_split.train.outputs,1);
  assert.deepEqual(calibration.heldout.gate,{true_positive:1,false_negative:1,false_positive:1,true_negative:1});
  assert.equal(calibration.heldout.brier_score,0.2418);
  assert.equal(calibration.heldout.excerptable_probability_expected_calibration_error,0.26);
  assert.deepEqual(calibration.heldout.actual_classification_keep_reasons,
    {combined_probability_below_gate:1,selected_non_excerptable_kind:1});
  assert.deepEqual(calibration.heldout.downstream_keep_reasons,{choice_kept_full_output:2});
  const high=calibration.heldout.combined_excerptable_probability_bins.at(-1);
  assert.equal(high.lower_inclusive,0.95);
  assert.equal(high.outputs,2);
  assert.equal(high.observed_positive_rate,0.5);
  assert.equal(calibration.heldout.selected_confidence_bins.find(bin=>bin.lower_inclusive===0.5).outputs,1);
});

test("missing classifier evidence stays unknown and local routes do not pad calibration", () => {
  const calibration=summarizeCoverage([run(),run({calls:1,stages:["classification"],
    item:{kind:"prose",split:"holdout"},health:{counter_scheme:1,responses_validated:1}})]).classification_calibration;
  assert.equal(calibration.validated_classifications_without_saved_evidence_or_label,1);
  assert.equal(calibration.heldout.outputs,0);
  assert.equal(calibration.heldout.brier_score,null);
  assert.equal(calibration.heldout.selected_kind_accuracy_percent,null);
});
