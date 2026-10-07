//! Stream all panel rows from immutable source and decisions without a Value tree.
use super::*;
use serde::ser::SerializeSeq;
use serde::{Serialize, Serializer};

#[derive(Serialize)]
struct Row<'a> {
    action: &'static str,
    can_omit: Option<f64>,
    exact_needed: Option<f64>,
    excerpt: &'a str,
    line: usize,
    protected_reason: Option<&'a str>,
    reason: &'a str,
    task_relevant: Option<f64>,
}

struct Rows<'a> {
    lines: &'a [SourceLine],
    decisions: &'a [codex_decision::LineDecision],
}

impl Serialize for Rows<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut rows =
            serializer.serialize_seq(Some(self.lines.len().min(self.decisions.len())))?;
        for (line, decision) in self.lines.iter().zip(self.decisions) {
            rows.serialize_element(&Row {
                action: if decision.action == Action::Omit {
                    "omit"
                } else {
                    "keep"
                },
                can_omit: decision.p_can_omit,
                exact_needed: decision.p_exact_needed,
                excerpt: excerpt(&line.model_text),
                line: line.number,
                protected_reason: decision.protected_reason.as_deref(),
                reason: &decision.reason,
                task_relevant: decision.p_task_relevant,
            })?;
        }
        rows.end()
    }
}

fn excerpt(text: &str) -> &str {
    let mut units = 0usize;
    let end = text
        .char_indices()
        .find_map(|(index, character)| {
            units += character.len_utf16();
            (units > 120).then_some(index)
        })
        .unwrap_or(text.len());
    &text[..end]
}

#[derive(Serialize)]
struct SnapshotBatch {
    count: usize,
    number: usize,
    target_count: usize,
}

#[derive(Serialize)]
struct Totals {
    classification_requests: usize,
    judged: usize,
    kept: usize,
    omitted: usize,
    protected: usize,
    requests: usize,
    seen: usize,
    unjudged: usize,
}

#[derive(Serialize)]
struct Snapshot<'a> {
    at: TimestampField<'a>,
    batch: SnapshotBatch,
    batch_elapsed_ms: u64,
    filter: &'a str,
    id: &'a str,
    receipt_id: &'a str,
    rows: Rows<'a>,
    status: &'a str,
    totals: Totals,
    version: u8,
}

#[allow(clippy::too_many_arguments)] // One immutable complete panel matches the publication contract.
pub(crate) fn prepare_line_snapshot(
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
) -> Result<PreparedJson, String> {
    let (judged, omitted, protected) =
        decisions
            .iter()
            .fold((0, 0, 0), |(judged, omitted, protected), row| {
                (
                    judged + usize::from(row.batch_id.is_some()),
                    omitted + usize::from(row.action == Action::Omit),
                    protected + usize::from(row.protected_reason.is_some()),
                )
            });
    let unjudged = lines
        .iter()
        .zip(decisions)
        .filter(|(line, row)| {
            line.eligible && line.protected_reason.is_none() && row.batch_id.is_none()
        })
        .count();
    let marker = TimestampMarker::default();
    let view = Snapshot {
        at: TimestampField(&marker),
        batch: SnapshotBatch {
            count: batch_count,
            number: batch_number,
            target_count: batch.target_numbers.len(),
        },
        batch_elapsed_ms: batch.elapsed_ms,
        filter: route,
        id: snapshot_id,
        receipt_id,
        rows: Rows { lines, decisions },
        status,
        version: 6,
        totals: Totals {
            classification_requests,
            judged,
            kept: lines.len() - omitted,
            omitted,
            protected,
            requests: batch_number + classification_requests,
            seen: lines.len(),
            unjudged,
        },
    };
    let capacity = lines
        .len()
        .saturating_mul(256)
        .saturating_add(1024)
        .checked_next_power_of_two()
        .unwrap_or(PANEL_SNAPSHOT_MAX_BYTES)
        .min(PANEL_SNAPSHOT_MAX_BYTES);
    let bytes = crate::encoding::encode_marked_with_capacity(
        &view,
        PANEL_SNAPSHOT_MAX_BYTES,
        "snapshot encoding",
        "panel snapshot too large",
        &marker.offset,
        capacity,
    )?;
    PreparedJson::new(
        bytes,
        &marker,
        PANEL_SNAPSHOT_MAX_BYTES,
        "panel snapshot too large",
    )
}

#[cfg(test)]
#[path = "encoding_tests.rs"]
pub(super) mod tests;
