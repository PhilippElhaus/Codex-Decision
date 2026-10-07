//! Borrow immutable evidence while preserving canonical private record bytes.
use super::*;
use serde::ser::SerializeSeq;
use serde::{Serialize, Serializer};
#[path = "encoding/bounded.rs"]
mod bounded;
use bounded::encode;
#[cfg(test)]
pub(super) use bounded::encode_marked;
pub(super) use bounded::encode_marked_with_capacity;
#[cfg(test)]
use bounded::BoundedRecord;

// Field order matches the previous sorted Value representation. Keep optional
// fields and floating-point values identical for historical replay readers.
#[derive(Serialize)]
struct Decision<'a> {
    action: &'a Action,
    #[serde(skip_serializing_if = "Option::is_none")]
    batch_id: Option<usize>,
    number: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    p_can_omit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    p_exact_needed: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    p_task_relevant: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    protected_reason: Option<&'a str>,
    reason: &'a str,
}

struct Decisions<'a>(&'a [codex_decision::LineDecision]);

impl Serialize for Decisions<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut rows = serializer.serialize_seq(Some(self.0.len()))?;
        for row in self.0 {
            rows.serialize_element(&Decision {
                action: &row.action,
                batch_id: row.batch_id,
                number: row.number,
                p_can_omit: row.p_can_omit,
                p_exact_needed: row.p_exact_needed,
                p_task_relevant: row.p_task_relevant,
                protected_reason: row.protected_reason.as_deref(),
                reason: &row.reason,
            })?;
        }
        rows.end()
    }
}

#[derive(Serialize)]
struct Receipt<'a, M> {
    decisions: Decisions<'a>,
    initial_output: &'a str,
    manifest: M,
    tool: Option<&'a Value>,
    tool_input: Option<&'a Value>,
    version: u8,
    visible_output: Option<&'a str>,
}

#[derive(Serialize)]
struct EvidenceBatch<'a> {
    elapsed_ms: u64,
    id: usize,
    request: &'a Value,
    response: &'a Value,
    target_numbers: &'a [usize],
}

#[derive(Serialize)]
struct BatchEnvelope<'a> {
    batch: EvidenceBatch<'a>,
    receipt_id: &'a str,
    version: u8,
}

#[cfg(test)]
pub(super) fn encode_receipt(
    manifest: &Value,
    event: &Value,
    source: &str,
    visible: Option<&str>,
    decisions: &[codex_decision::LineDecision],
) -> Result<Vec<u8>, String> {
    encode(
        &Receipt {
            decisions: Decisions(decisions),
            initial_output: source,
            manifest,
            tool: event.get("tool_name"),
            tool_input: event.get("tool_input"),
            version: 3,
            visible_output: visible,
        },
        MAX_RECEIPT_BYTES,
        "receipt encoding",
        "receipt too large",
    )
}

pub(super) fn prepare_receipt(
    manifest: &Value,
    event: &Value,
    source: &str,
    visible: Option<&str>,
    decisions: &[codex_decision::LineDecision],
) -> Result<PreparedJson, String> {
    let marker = TimestampMarker::default();
    let manifest = TimestampMap::new(manifest, &marker)?;
    let capacity = source
        .len()
        .saturating_add(visible.map_or(0, str::len))
        .saturating_add(decisions.len().saturating_mul(112))
        .saturating_add(1024)
        .checked_next_power_of_two()
        .unwrap_or(MAX_RECEIPT_BYTES)
        .min(MAX_RECEIPT_BYTES);
    let bytes = encode_marked_with_capacity(
        &Receipt {
            decisions: Decisions(decisions),
            initial_output: source,
            manifest,
            tool: event.get("tool_name"),
            tool_input: event.get("tool_input"),
            version: 3,
            visible_output: visible,
        },
        MAX_RECEIPT_BYTES,
        "receipt encoding",
        "receipt too large",
        &marker.offset,
        capacity,
    )?;
    PreparedJson::new(bytes, &marker, MAX_RECEIPT_BYTES, "receipt too large")
}

pub(super) fn encode_batch(receipt_id: &str, batch: &BatchRecord) -> Result<Vec<u8>, String> {
    encode(
        &BatchEnvelope {
            batch: EvidenceBatch {
                elapsed_ms: batch.elapsed_ms,
                id: batch.id,
                request: &batch.request,
                response: &batch.response,
                target_numbers: &batch.target_numbers,
            },
            receipt_id,
            version: 2,
        },
        2 * 1024 * 1024,
        "batch encoding",
        "batch record too large",
    )
}

#[cfg(test)]
#[path = "encoding_tests.rs"]
mod tests;
