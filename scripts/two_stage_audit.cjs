"use strict";
// Reconcile one isolated hook invocation with the mock/proxy and saved counters.
const excerptable = new Set(["repetitive_log", "progress_output", "independent_matches", "independent_records"]);

function requireProxyHook(binary) {
  if (!binary.includes(Buffer.from("CODEX_DECISION_TEST_ENDPOINT"))) {
    throw new Error("This runner requires a debug hook with CODEX_DECISION_TEST_ENDPOINT support; build the debug hook before testing.");
  }
}

function auditRun({ item, calls, stages, receipt, health, stats, activity, error, replaced, live }) {
  const failures = [];
  const recorded = health?.api_requests ?? 0;
  const classified = stages.filter(stage => stage === "classification").length;
  const relevant = stages.filter(stage => stage === "relevance").length;
  const expectedError = !!(item.fault || item.expect_error);
  const disabled = item.enabled === false;
  const classificationKeep = classified === 1 && !relevant && health?.last_skip === "choice_kept_full_output";
  if (recorded !== calls) failures.push("proxy_request_count_differs_from_hook_health");
  if (classified + relevant !== calls || classified > 1 || classified && stages[0] !== "classification") {
    failures.push("invalid_request_stage_sequence");
  }
  if (health?.counter_scheme === 1) {
    const counts = [health.responses_received, health.responses_validated, health.request_failures, health.request_cancelled];
    const [received, validated, failed, cancelled] = counts;
    if (counts.some(value => !Number.isSafeInteger(value) || value < 0) ||
        validated > received || received > calls - cancelled ||
        validated + failed + cancelled !== calls || receipt && validated !== calls ||
        classificationKeep && validated !== calls) {
      failures.push("request_outcome_counts_not_reconciled");
    }
  }
  if (item.expected_calls !== undefined && calls !== item.expected_calls) failures.push("unexpected_request_count");
  if (item.expected_classification_calls !== undefined && classified !== item.expected_classification_calls) failures.push("unexpected_classification_count");
  if (item.expected_relevance_calls !== undefined && relevant !== item.expected_relevance_calls) failures.push("unexpected_relevance_count");
  if (!!error !== expectedError) failures.push(error ? "unexpected_hook_error" : "expected_error_not_observed");
  if ((health?.errors ?? 0) !== Number(!!error)) failures.push("error_count_differs_from_observed_error");
  if (!disabled && (!health || (!item.expect_error && health.seen !== 1))) failures.push("hook_invocation_not_recorded");
  if (disabled && (health || calls || receipt)) failures.push("disabled_hook_recorded_activity");
  if (receipt) {
    if (receipt.manifest.requests !== calls || Number(receipt.manifest.choice_gate_ran) !== classified || !relevant) {
      failures.push("receipt_request_counts_differ_from_proxy");
    }
  } else if (!expectedError && !disabled && (item.expected_decision || !item.expect_full &&
      !(classificationKeep && (live || !excerptable.has(item.kind))))) {
    failures.push("eligible_output_silently_skipped");
  }
  if ((stats?.completed ?? 0) !== Number(!!receipt) || (stats?.replaced ?? 0) !== Number(!!replaced)) {
    failures.push("completion_statistics_differ_from_result");
  }
  if ((stats?.calls ?? 0) !== (receipt?.manifest.requests ?? activity?.requests ?? 0)) {
    failures.push("recorded_completion_requests_differ_from_result");
  }
  if (item.expected_skip !== undefined && health?.last_skip !== item.expected_skip) failures.push("unexpected_skip_reason");
  let outcome;
  if (disabled) outcome = "disabled";
  else if (error) outcome = "error";
  else if (receipt) outcome = replaced ? "evaluated" : receipt.manifest.status === "candidate" ? "preview" : "evaluated_keep";
  else if (classificationKeep) outcome = "classification_keep";
  else outcome = item.expect_full || item.expected_skip || item.expected_calls === 0 ? "intended_local_skip" : "unexpected_skip";
  const abort = recorded !== calls ? "Hook bypassed the testing proxy or failed before the proxy recorded its request." :
    live && failures.includes("request_outcome_counts_not_reconciled") ? "Saved request outcomes do not reconcile; stop live requests before spending more." :
    live && error && !expectedError ? "Unexpected hook error; stop live requests before repeating the failure." : null;
  return { failures, abort, outcome, recorded_requests: recorded, classification_attempts: classified, relevance_attempts: relevant };
}

module.exports = { requireProxyHook, auditRun };
