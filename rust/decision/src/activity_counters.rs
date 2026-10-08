//! Typed, versioned activity counters and conservative legacy coverage.
use serde_json::Value;
mod consistency;
mod coverage;
mod metadata;
mod retained;
pub use consistency::{completed_request_minimum, counters_conflict, stats_baseline_is_fresh};
pub use coverage::{bootstrap_health_counters, partial_metric_names, prepare_stats_counters};
pub use metadata::request_outcomes_covered;
pub use retained::retained_stats_from_events;

pub const HEALTH_COUNTERS: &[&str] = &[
    "seen",
    "skipped",
    "errors",
    "api_requests",
    "request_cancelled",
    "responses_received",
    "responses_validated",
    "request_failures",
];
pub const REQUEST_OUTCOME_COUNTERS: &[&str] = &[
    "request_cancelled",
    "responses_received",
    "responses_validated",
    "request_failures",
];
pub const HEALTH_METRICS: &[(&str, &str)] = &[
    ("seen", "seen"),
    ("skipped", "skipped"),
    ("errors", "errors"),
    ("api_requests", "calls"),
    ("request_cancelled", "requestCancelled"),
    ("responses_received", "responsesReceived"),
    ("responses_validated", "responsesValidated"),
    ("request_failures", "requestFailures"),
];

pub const STATS_COUNTERS: &[&str] = &[
    "calls",
    "completed",
    "replaced",
    "timed",
    "elapsedMs",
    "savedChars",
    "candidates",
    "kept",
    "linesSeen",
    "linesJudged",
    "linesKept",
    "linesOmitted",
    "linesProtected",
    "linesUnjudged",
    "linesRelevanceJudged",
    "linesBelowOmitCutoff",
    "linesRelevanceKept",
    "linesActuallyOmitted",
];
pub const LEGACY_PARTIAL_STATS: &[&str] = &[
    "candidates",
    "kept",
    "linesActuallyOmitted",
    "linesRelevanceJudged",
];

pub fn validate_health_counters(health: &Value) -> Result<(), String> {
    if !health.is_object() {
        return Err("invalid hook health".into());
    }
    metadata::validate(health)?;
    if health
        .get("counter_scheme")
        .is_some_and(|value| value.as_u64() != Some(1))
    {
        return Err("unsupported hook counter scheme".into());
    }
    if health.get("counter_scheme").is_some() && health.get("partial_counters").is_none() {
        return Err("missing counter coverage".into());
    }
    if let Some(value) = health.get("partial_counters") {
        let names = value.as_array().ok_or("invalid partial counters")?;
        let mut unique = std::collections::BTreeSet::new();
        if names.len() > HEALTH_COUNTERS.len()
            || names.iter().any(|name| {
                !name
                    .as_str()
                    .is_some_and(|name| HEALTH_COUNTERS.contains(&name) && unique.insert(name))
            })
        {
            return Err("invalid partial counters".into());
        }
    }
    for name in ["skip_reasons_partial", "skip_details_partial"] {
        if health
            .get(name)
            .is_some_and(|value| value.as_bool().is_none())
        {
            return Err("invalid counter coverage".into());
        }
    }
    for name in HEALTH_COUNTERS {
        if health
            .get(name)
            .is_some_and(|value| value.as_u64().is_none())
        {
            return Err("invalid hook health counter".into());
        }
        if health.get("counter_scheme").is_some()
            && health.get(*name).is_none()
            && !health["partial_counters"]
                .as_array()
                .is_some_and(|names| names.iter().any(|value| value == name))
        {
            return Err("missing hook health counter".into());
        }
    }
    for name in ["skip_counts", "skip_details"] {
        if let Some(value) = health.get(name) {
            let counts = value.as_object().ok_or("invalid hook health counters")?;
            if counts.len() > 80
                || counts.iter().any(|(reason, count)| {
                    reason.is_empty()
                        || reason.len() > 80
                        || !reason.bytes().all(|byte| {
                            byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'
                        })
                        || !reason.as_bytes()[0].is_ascii_lowercase()
                        || count.as_u64().is_none()
                })
            {
                return Err("invalid hook health counters".into());
            }
        }
    }
    Ok(())
}

pub fn checked_counter_add(previous: u64, increment: u64) -> Result<u64, String> {
    previous
        .checked_add(increment)
        .ok_or_else(|| "counter overflow".into())
}

pub fn validate_stats_counters(value: &Value) -> Result<(), String> {
    let object = value.as_object().ok_or("invalid stats file")?;
    if object.len() > 128 || object.values().any(|item| item.as_u64().is_none()) {
        return Err("invalid stats value".into());
    }
    if value
        .get("counter_scheme")
        .is_some_and(|scheme| scheme.as_u64() != Some(1))
    {
        return Err("unsupported stats counter scheme".into());
    }
    if object.iter().any(|(key, value)| {
        key.strip_prefix("partial_").is_some_and(|name| {
            !STATS_COUNTERS.contains(&name) || value.as_u64().is_none_or(|value| value > 1)
        })
    }) {
        return Err("invalid stats counter coverage".into());
    }
    Ok(())
}
