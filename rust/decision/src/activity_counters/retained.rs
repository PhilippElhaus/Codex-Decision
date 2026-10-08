//! Retained metadata is a minimum, never a reconstructed full-session baseline.
use super::*;
use crate::strict_json;
use serde_json::json;

pub fn retained_stats_from_events(bytes: &[u8], truncated: bool) -> Result<Value, String> {
    let begin = if !truncated {
        0
    } else {
        bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(bytes.len(), |index| index + 1)
    };
    let end = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(begin, |index| index + 1)
        .max(begin);
    let mut stats =
        json!({"calls":0,"completed":0,"replaced":0,"timed":0,"elapsedMs":0,"savedChars":0});
    for row in bytes[begin..end].split(|byte| *byte == b'\n') {
        if row.len() > 8192 {
            continue;
        }
        let Ok(event) = strict_json::parse(row) else {
            continue;
        };
        if !valid_unsigned_fields(&event) {
            continue;
        }
        let (Some(status), Some(reason)) = (event["status"].as_str(), event["reason"].as_str())
        else {
            continue;
        };
        let requests = event["requests"]
            .as_u64()
            .filter(|count| *count <= 10_001)
            .unwrap_or(0);
        increment(
            &mut stats,
            "calls",
            if status == "calling" { 1 } else { requests },
        )?;
        let outcome = matches!(status, "candidate" | "keep" | "replace");
        if outcome || reason == "choice_kept_full_output" {
            if let Some(elapsed) = event["elapsed_ms"].as_u64().filter(|elapsed| *elapsed > 0) {
                increment(&mut stats, "timed", requests.max(1))?;
                increment(&mut stats, "elapsedMs", elapsed)?;
            }
        }
        if outcome {
            increment(&mut stats, "completed", 1)?;
        }
        if status == "replace" {
            increment(&mut stats, "replaced", 1)?;
            if let (Some(original), Some(visible)) = (
                event["original_chars"].as_u64(),
                event["capsule_chars"].as_u64(),
            ) {
                increment(&mut stats, "savedChars", original.saturating_sub(visible))?;
            }
        }
    }
    prepare_stats_counters(&mut stats, true)?;
    for name in STATS_COUNTERS {
        stats[format!("partial_{name}")] = json!(1);
    }
    Ok(stats)
}

fn valid_unsigned_fields(event: &Value) -> bool {
    [
        "requests",
        "elapsed_ms",
        "original_chars",
        "capsule_chars",
        "lines_judged",
        "lines_relevance_judged",
        "lines_relevance_kept",
    ]
    .iter()
    .all(|name| {
        event.get(*name).is_none_or(|value| {
            value.is_null()
                || value
                    .as_u64()
                    .is_some_and(|count| *name != "requests" || count <= 10_001)
        })
    })
}

fn increment(stats: &mut Value, name: &str, amount: u64) -> Result<(), String> {
    stats[name] = json!(checked_counter_add(
        stats[name].as_u64().unwrap_or(0),
        amount
    )?);
    Ok(())
}

#[cfg(test)]
#[path = "retained_tests.rs"]
mod tests;
