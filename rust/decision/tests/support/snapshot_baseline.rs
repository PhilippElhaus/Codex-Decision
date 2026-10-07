//! Frozen version-6 rows and totals from 4b24210; time is an explicit fixture.
use codex_decision::{Action, BatchRecord, SourceLine};
use serde_json::{json, Value};
#[allow(clippy::too_many_arguments)] // A complete immutable batch record is assembled here.
pub(crate) fn line_snapshot(
    receipt_id: &str,
    snapshot_id: &str,
    route: &str,
    status: &str,
    lines: &[SourceLine],
    decisions: &[codex_decision::LineDecision],
    batch: &BatchRecord,
    batch_number: usize,
    batch_count: usize,
    classification_requests: usize,
    timestamp: &str,
) -> Value {
    let seen = lines.len();
    let judged = decisions
        .iter()
        .filter(|row| row.batch_id.is_some())
        .count();
    let omitted = decisions
        .iter()
        .filter(|row| row.action == Action::Omit)
        .count();
    let protected = decisions
        .iter()
        .filter(|row| row.protected_reason.is_some())
        .count();
    let rows: Vec<Value> = lines
        .iter()
        .zip(decisions)
        .map(|(line, decision)| {
            let excerpt: String = line
                .model_text
                .chars()
                .scan(0usize, |units, character| {
                    *units += character.len_utf16();
                    (*units <= 120).then_some(character)
                })
                .collect();
            json!({"line":line.number,"excerpt":excerpt,
                "action":if decision.action == Action::Omit { "omit" } else { "keep" },
                "reason":decision.reason,"can_omit":decision.p_can_omit,
                "exact_needed":decision.p_exact_needed,"task_relevant":decision.p_task_relevant,
                "protected_reason":decision.protected_reason})
        })
        .collect();
    let unjudged = lines
        .iter()
        .zip(decisions)
        .filter(|(line, decision)| {
            line.eligible && line.protected_reason.is_none() && decision.batch_id.is_none()
        })
        .count();
    json!({"version":6,"id":snapshot_id,"receipt_id":receipt_id,"at":timestamp,
        "filter":route,"status":status,"batch":{"number":batch_number,"count":batch_count,
            "target_count":batch.target_numbers.len()},"rows":rows,
        "totals":{"seen":seen,"judged":judged,"kept":seen-omitted,"omitted":omitted,
            "protected":protected,"unjudged":unjudged,"requests":batch_number + classification_requests,
            "classification_requests":classification_requests},
        "batch_elapsed_ms":batch.elapsed_ms})
}
