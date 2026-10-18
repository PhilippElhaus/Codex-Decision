"use strict";

// Count invocations, not requests or receipts. Inputs are synthetic runner data;
// this report never establishes delivery at the model-context boundary.
const SKIPS = new Set(["unsupported_event", "unsupported_route", "unsupported_result", "small", "large",
  "tool_input_budget", "line_budget", "exact_content", "sensitive", "structured_or_empty", "structure_guard",
  "mcp_replacement_disabled", "unsafe_task_context", "exhaustive_task", "insufficient_savings",
  "choice_kept_full_output", "no_eligible_lines", "relevance_budget"]);
const KINDS = ["repetitive_log", "progress_output", "independent_matches", "independent_records",
  "exact_content", "prose", "structured_payload", "mixed_or_unknown"];
const EXCERPTABLE = new Set(KINDS.slice(0, 4));
const GATE = 0.95;

// Read saved, validated classifier evidence. The runtime uses normalized object
// answers; accepting provider arrays also permits auditing the original wire.
function classificationEvidence(answer) {
  if (!answer || answer.type !== "choice" || !KINDS.includes(answer.choice) ||
      !Number.isFinite(answer.confidence) || answer.confidence < 0 || answer.confidence > 1) return null;
  const entries = Array.isArray(answer.probabilities) ? answer.probabilities.map(row => [row?.value, row?.probability]) :
    answer.probabilities && typeof answer.probabilities === "object" ? Object.entries(answer.probabilities) : [];
  if (entries.length !== KINDS.length || new Set(entries.map(([kind]) => kind)).size !== KINDS.length ||
      entries.some(([kind, p]) => !KINDS.includes(kind) || !Number.isFinite(p) || p < 0 || p > 1)) return null;
  const probabilities = Object.fromEntries(entries);
  const total = entries.reduce((sum, [, p]) => sum + p, 0);
  if (Math.abs(total - 1) > 0.02 + 1e-9 || probabilities[answer.choice] + 1e-9 < Math.max(...entries.map(([, p]) => p))) return null;
  const combined = KINDS.slice(0, 4).reduce((sum, kind) => sum + probabilities[kind], 0) / total;
  return { selected_kind: answer.choice, selected_confidence: answer.confidence,
    combined_excerptable_probability: combined,
    gate_passes: EXCERPTABLE.has(answer.choice) && combined >= GATE };
}

function toolFamily(tool) {
  if (["exec", "wait", "functions.exec", "functions.wait"].includes(tool)) return "code_mode";
  if (["Bash", "exec_command", "functions.exec_command", "write_stdin", "functions.write_stdin"].includes(tool)) return "shell";
  if (typeof tool === "string" && /^(?:functions\.)?mcp__lab_control__/.test(tool)) return "native_lab";
  if (typeof tool === "string" && /^(?:functions\.)?mcp__/.test(tool)) return "other_mcp";
  return "other";
}

function caseCoverage({ item, tool, source, visible, toolResponse, calls, forwardedCalls = 0,
  providerResponses = 0, stages, receipt, activity, health, replaced, originalExact, envelopeExact,
  requiredLines, requiredLost, proposedRequiredLost, classification = null, labelSplit = "unassigned" }) {
  const classificationValidated = stages[0] === "classification" && (
    receipt?.manifest.choice_gate_ran === true || !!activity?.classification ||
    health?.counter_scheme === 1 && health.responses_validated > 0);
  const sourceBytes = Buffer.byteLength(source), visibleBytes = Buffer.byteLength(visible);
  const required = new Set(requiredLines);
  const completedRequired = receipt?.decisions.filter(row => required.has(row.number)) || [];
  const evidence = classificationValidated ? classificationEvidence(classification || activity?.classification) : null;
  const skipReason = health?.last_skip ? SKIPS.has(health.last_skip) ? health.last_skip : "unrecorded" : null;
  const calibration = evidence && KINDS.includes(item.kind) ? { ...evidence,
    label_split: item.split || labelSplit,
    reviewed_kind: item.kind, reviewed_excerptable: EXCERPTABLE.has(item.kind),
    selected_kind_correct: evidence.selected_kind === item.kind,
    keep_reason: skipReason === "choice_kept_full_output" ?
      !EXCERPTABLE.has(evidence.selected_kind) ? "selected_non_excerptable_kind" :
        evidence.combined_excerptable_probability < GATE ? "combined_probability_below_gate" : "unexpected_gate_keep" : null,
    downstream_keep_reason: skipReason || (!replaced ? receipt?.manifest.reason || null : null),
  } : null;
  return {
    enabled: item.enabled !== false,
    fault_control: !!(item.fault || item.expect_error),
    tool_family: toolFamily(tool),
    source_size_band: sourceBytes < 256 ? "under_256" : sourceBytes < 1024 ? "256_1023" :
      sourceBytes < 4096 ? "1024_4095" : sourceBytes < 16384 ? "4096_16383" :
        sourceBytes < 65536 ? "16384_65535" : "65536_plus",
    safe_opportunity: item.safe_opportunity === true,
    must_stay_local: item.must_stay_local === true,
    source_projection_bytes: sourceBytes,
    kept_projection_bytes: visibleBytes,
    tool_response_wire_bytes: Buffer.byteLength(JSON.stringify(toolResponse)),
    hook_saved_bytes: sourceBytes - visibleBytes,
    proxy_requests: calls,
    forwarded_provider_requests: forwardedCalls,
    provider_responses_received: providerResponses,
    validated_classification: classificationValidated,
    classification_calibration: calibration,
    completed_line_evaluation: !!receipt,
    replacement_prepared: !!replaced,
    candidate_preview: receipt?.manifest.status === "candidate",
    evaluated_keep: receipt?.manifest.status === "keep",
    skip_reason: skipReason,
    hook_error: !!health?.last_error,
    failed_request_attempts: health?.request_failures ?? 0,
    original_verified: replaced ? originalExact === true && receipt?.initial_output === source &&
      (typeof toolResponse === "string" || envelopeExact === true) : null,
    required_lines: required.size,
    required_lines_in_completed_decisions: completedRequired.length,
    required_lines_model_judged: completedRequired.filter(row => typeof row.p_task_relevant === "number").length,
    required_lines_protected: completedRequired.filter(row => !!row.protected_reason && typeof row.p_task_relevant !== "number").length,
    required_lines_retained_by_post_judgment_guard: completedRequired.filter(row => !!row.protected_reason && typeof row.p_task_relevant === "number").length,
    required_lines_lost: requiredLost.length,
    proposed_required_lines_lost: proposedRequiredLost.length,
  };
}

const percent = (numerator, denominator) => denominator ? Number((100 * numerator / denominator).toFixed(4)) : null;
const mean = values => values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(6)) : null;

function calibrationBins(rows, probability, truth) {
  // Preset before the held-out trial. The last bin matches the unchanged gate.
  const edges = [0, 0.1, 0.5, 0.8, GATE, 1];
  return edges.slice(0, -1).map((lower, index) => {
    const upper = edges[index + 1];
    const selected = rows.filter(row => probability(row) >= lower &&
      (index === edges.length - 2 ? probability(row) <= upper : probability(row) < upper));
    return { lower_inclusive: lower, upper: upper, upper_inclusive: index === edges.length - 2,
      outputs: selected.length, mean_probability: mean(selected.map(probability)),
      observed_positive_rate: mean(selected.map(row => Number(truth(row)))) };
  });
}

function calibrationAggregate(rows) {
  const combined = row => row.combined_excerptable_probability;
  const excerptable = row => row.reviewed_excerptable;
  const probabilityBins = calibrationBins(rows, combined, excerptable);
  const confidenceBins = calibrationBins(rows, row => row.selected_confidence, row => row.selected_kind_correct);
  const ece = bins => rows.length ? Number((bins.reduce((sum, bin) => sum + bin.outputs *
    Math.abs((bin.mean_probability ?? 0) - (bin.observed_positive_rate ?? 0)), 0) / rows.length).toFixed(6)) : null;
  const count = predicate => rows.filter(predicate).length;
  const keepReasons = {};
  const downstream = {};
  for (const row of rows) {
    if (row.keep_reason) keepReasons[row.keep_reason] = (keepReasons[row.keep_reason] || 0) + 1;
    if (row.downstream_keep_reason) downstream[row.downstream_keep_reason] = (downstream[row.downstream_keep_reason] || 0) + 1;
  }
  return { outputs: rows.length, reviewed_excerptable_outputs: count(excerptable),
    reviewed_full_output_outputs: count(row => !excerptable(row)),
    correct_selected_kinds: count(row => row.selected_kind_correct),
    selected_kind_accuracy_percent: percent(count(row => row.selected_kind_correct), rows.length),
    brier_score: mean(rows.map(row => (combined(row) - Number(excerptable(row))) ** 2)),
    excerptable_probability_expected_calibration_error: ece(probabilityBins),
    selected_confidence_expected_calibration_error: ece(confidenceBins),
    gate: { true_positive: count(row => row.gate_passes && excerptable(row)),
      false_negative: count(row => !row.gate_passes && excerptable(row)),
      false_positive: count(row => row.gate_passes && !excerptable(row)),
      true_negative: count(row => !row.gate_passes && !excerptable(row)) },
    actual_classification_keep_reasons: keepReasons, downstream_keep_reasons: downstream,
    combined_excerptable_probability_bins: probabilityBins, selected_confidence_bins: confidenceBins };
}

function classificationCalibration(rows) {
  const evidence = rows.map(row => row.classification_calibration).filter(Boolean);
  const bySplit = {};
  for (const split of [...new Set(evidence.map(row => row.label_split))].sort()) {
    bySplit[split] = calibrationAggregate(evidence.filter(row => row.label_split === split));
  }
  return { gate_minimum_combined_excerptable_probability: GATE,
    definition: "Classifier evidence only; locally validated routes do not enter calibration. Reviewed labels do not establish safe line omission.",
    validated_classifications_without_saved_evidence_or_label: rows.filter(row => row.validated_classification && !row.classification_calibration).length,
    heldout: calibrationAggregate(evidence.filter(row => row.label_split === "holdout")),
    by_label_split: bySplit };
}

function aggregate(rows, live) {
  const count = predicate => rows.filter(predicate).length;
  const sum = name => rows.reduce((total, row) => total + row[name], 0);
  const called = rows.filter(row => row.proxy_requests > 0);
  const opportunities = rows.filter(row => row.safe_opportunity);
  const missed = opportunities.filter(row => row.proxy_requests === 0);
  const local = rows.filter(row => row.must_stay_local);
  const replacements = rows.filter(row => row.replacement_prepared);
  const bytes = selected => selected.reduce((total, row) => total + row.source_projection_bytes, 0);
  const result = {
    outputs: rows.length,
    outputs_reaching_proxy: called.length,
    outputs_forwarded_to_provider: live ? count(row => row.forwarded_provider_requests > 0) : null,
    outputs_with_provider_response: live ? count(row => row.provider_responses_received > 0) : null,
    outputs_with_validated_classification: count(row => row.validated_classification),
    completed_line_evaluations: count(row => row.completed_line_evaluation),
    classification_keeps: count(row => row.skip_reason === "choice_kept_full_output"),
    replacements_prepared: replacements.length,
    candidate_previews: count(row => row.candidate_preview),
    evaluated_keeps: count(row => row.evaluated_keep),
    local_skips: count(row => !!row.skip_reason && row.proxy_requests === 0),
    post_request_skips: count(row => !!row.skip_reason && row.proxy_requests > 0),
    hook_error_outputs: count(row => row.hook_error),
    proxy_requests: sum("proxy_requests"),
    forwarded_provider_requests: live ? sum("forwarded_provider_requests") : null,
    failed_request_attempts: sum("failed_request_attempts"),
    source_projection_bytes: sum("source_projection_bytes"),
    source_projection_bytes_reaching_proxy: bytes(called),
    kept_projection_bytes: sum("kept_projection_bytes"),
    tool_response_wire_bytes: sum("tool_response_wire_bytes"),
    hook_saved_bytes: sum("hook_saved_bytes"),
    required_lines: sum("required_lines"),
    required_lines_in_completed_decisions: sum("required_lines_in_completed_decisions"),
    required_lines_model_judged: sum("required_lines_model_judged"),
    required_lines_protected: sum("required_lines_protected"),
    required_lines_retained_by_post_judgment_guard: sum("required_lines_retained_by_post_judgment_guard"),
    required_lines_in_replacements: replacements.reduce((total, row) => total + row.required_lines, 0),
    required_lines_model_judged_in_replacements: replacements.reduce((total, row) => total + row.required_lines_model_judged, 0),
    required_lines_protected_in_replacements: replacements.reduce((total, row) => total + row.required_lines_protected, 0),
    required_lines_lost: sum("required_lines_lost"),
    proposed_required_lines_lost: sum("proposed_required_lines_lost"),
    unverified_replacement_originals: replacements.filter(row => row.original_verified !== true).length,
    labeled_safe_opportunity_outputs: opportunities.length,
    labeled_safe_opportunity_bytes: bytes(opportunities),
    safe_opportunities_reaching_proxy: opportunities.length - missed.length,
    safe_opportunities_forwarded_to_provider: live ? opportunities.filter(row => row.forwarded_provider_requests > 0).length : null,
    safe_opportunities_with_completed_line_evaluation: opportunities.filter(row => row.completed_line_evaluation).length,
    safe_opportunities_with_prepared_replacement: opportunities.filter(row => row.replacement_prepared).length,
    missed_safe_opportunities: missed.length,
    missed_safe_opportunity_bytes: bytes(missed),
    must_stay_local_outputs: local.length,
    must_stay_local_request_violations: local.filter(row => row.proxy_requests > 0).length,
  };
  result.proxy_participation_percent = percent(called.length, rows.length);
  result.provider_forwarded_participation_percent = live ? percent(result.outputs_forwarded_to_provider, rows.length) : null;
  result.source_byte_participation_percent = percent(bytes(called), bytes(rows));
  result.labeled_safe_opportunity_participation_percent = percent(opportunities.length - missed.length, opportunities.length);
  result.labeled_safe_opportunity_provider_participation_percent = live ?
    percent(result.safe_opportunities_forwarded_to_provider, opportunities.length) : null;
  result.hook_byte_reduction_percent = percent(result.hook_saved_bytes, result.source_projection_bytes);
  result.actual_required_line_loss_in_replacements_percent = percent(result.required_lines_lost, result.required_lines_in_replacements);
  result.proposed_required_line_loss_in_completed_decisions_percent = percent(result.proposed_required_lines_lost, result.required_lines_in_completed_decisions);
  return result;
}

function summarizeCoverage(reports, { live = false } = {}) {
  const rows = reports.map(report => report.coverage);
  if (rows.some(row => !row)) throw new Error("Missing invocation coverage");
  const workload = rows.filter(row => row.enabled && !row.fault_control);
  const group = field => {
    const result = {};
    for (const value of [...new Set(workload.map(row => row[field]).filter(Boolean))].sort()) {
      result[value] = aggregate(workload.filter(row => row[field] === value), live);
    }
    return result;
  };
  return {
    schema_version: 1,
    measurement: live ? "synthetic_provider_trial" : "offline_mock_routing_only",
    byte_boundary: "reviewed_source_projection_including_preserved_metadata",
    source_byte_participation_definition: "Full source bytes of outputs reaching the proxy; not serialized API request bytes",
    required_line_exposure_definition: "Model-judged labels have a relevance probability; protected labels bypassed judgment; post-judgment guards are separate",
    delivered_savings_bytes: null,
    classification_calibration: classificationCalibration(workload),
    workload: aggregate(workload, live),
    by_tool_family: group("tool_family"),
    by_skip_reason: group("skip_reason"),
    by_size_band: group("source_size_band"),
    fault_controls: aggregate(rows.filter(row => row.enabled && row.fault_control), live),
    disabled_controls: aggregate(rows.filter(row => !row.enabled), live),
  };
}

module.exports = { caseCoverage, summarizeCoverage, toolFamily, classificationEvidence };
