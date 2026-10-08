//! Detect torn reads only where the complete counter baseline is known.
use super::*;

pub fn stats_baseline_is_fresh(stats: &Value) -> bool {
    stats["counter_scheme"] == 1
        && stats.as_object().is_some_and(|object| {
            object
                .iter()
                .all(|(name, value)| !name.starts_with("partial_") || value != 1)
        })
}

pub fn completed_request_minimum(stats: &Value) -> u64 {
    // Python-era calls counted pre-transport intents. Only a fresh scheme's
    // ledger, without incomplete migration coverage, proves valid answers.
    if !stats_baseline_is_fresh(stats) {
        return 0;
    }
    stats["calls"].as_u64().unwrap_or(0)
}

pub fn counters_conflict(stats: &Value, health: &Value) -> bool {
    let recorded = stats["calls"].as_u64().unwrap_or(0);
    let partial = |name: &str| {
        health["partial_counters"]
            .as_array()
            .is_some_and(|names| names.iter().any(|value| value == name))
    };
    if health["counter_scheme"] == 1
        && !partial("api_requests")
        && health["api_requests"]
            .as_u64()
            .is_some_and(|attempts| attempts < recorded)
    {
        return true;
    }
    let required = [
        "api_requests",
        "responses_received",
        "responses_validated",
        "request_failures",
        "request_cancelled",
    ];
    if health["counter_scheme"] != 1
        || !request_outcomes_covered(health)
        || required.iter().any(|name| {
            health[*name].as_u64().is_none()
                || health["partial_counters"]
                    .as_array()
                    .is_some_and(|names| names.iter().any(|value| value == name))
        })
    {
        return false;
    }
    let attempts = health["api_requests"].as_u64().unwrap().max(recorded);
    let completed = completed_request_minimum(stats);
    let received = health["responses_received"]
        .as_u64()
        .unwrap()
        .max(completed);
    let validated = health["responses_validated"]
        .as_u64()
        .unwrap()
        .max(completed);
    let cancelled = health["request_cancelled"].as_u64().unwrap();
    let failures = health["request_failures"].as_u64().unwrap();
    validated > received
        || attempts
            .checked_sub(cancelled)
            .is_none_or(|sent| received > sent)
        || validated
            .checked_add(failures)
            .and_then(|count| count.checked_add(cancelled))
            .is_none_or(|outcomes| outcomes > attempts)
}
