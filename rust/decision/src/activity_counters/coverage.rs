//! Coverage survives upgrades without inventing a historical baseline.
use super::*;
use serde_json::json;
use std::collections::BTreeSet;

pub fn bootstrap_health_counters(
    health: &mut Value,
    had_health: bool,
    had_stats: bool,
    recorded_requests: Option<u64>,
) -> Result<bool, String> {
    validate_health_counters(health)?;
    if health.get("counter_scheme").is_some() {
        if !request_outcomes_covered(health) {
            let names = health["partial_counters"]
                .as_array_mut()
                .ok_or("missing counter coverage")?;
            for name in REQUEST_OUTCOME_COUNTERS {
                if !names.iter().any(|value| value == name) {
                    names.push(json!(name));
                }
            }
        }
        return Ok(false);
    }
    let legacy = had_health || had_stats;
    health["counter_scheme"] = json!(1);
    health["partial_counters"] = if legacy {
        json!(HEALTH_COUNTERS)
    } else {
        json!([])
    };
    health["skip_reasons_partial"] = json!(legacy);
    health["skip_details_partial"] = json!(legacy);
    if !legacy {
        for name in HEALTH_COUNTERS {
            health[*name] = json!(0);
        }
    } else if !had_health {
        if let Some(count) = recorded_requests {
            health["api_requests"] = json!(count);
        }
        health.as_object_mut().unwrap().remove("errors");
    }
    Ok(!legacy)
}

pub fn prepare_stats_counters(stats: &mut Value, existed: bool) -> Result<(), String> {
    if let Some(scheme) = stats.get("counter_scheme") {
        if scheme.as_u64() != Some(1) {
            return Err("unsupported stats counter scheme".into());
        }
        return Ok(());
    }
    if existed {
        for name in STATS_COUNTERS {
            if stats.get(*name).is_none() || LEGACY_PARTIAL_STATS.contains(name) {
                stats[format!("partial_{name}")] = json!(1);
            }
        }
    } else {
        for name in STATS_COUNTERS {
            stats[*name] = json!(0);
        }
    }
    stats["counter_scheme"] = json!(1);
    Ok(())
}

pub fn partial_metric_names(stats: &Value, health: &Value, has_activity: bool) -> BTreeSet<String> {
    let mut partial = BTreeSet::new();
    let has_health = health.as_object().is_some_and(|object| !object.is_empty());
    let has_stats = stats.as_object().is_some_and(|object| !object.is_empty());
    let marked = |name: &str| {
        health["partial_counters"]
            .as_array()
            .is_some_and(|names| names.iter().any(|value| value.as_str() == Some(name)))
    };
    // A durable request intent precedes its once-only outcome write. Pending
    // work, a failed outcome write, or a killed process leaves stage totals as
    // minima until every intent has a recorded terminal outcome.
    let pending_outcomes = match (
        health["api_requests"].as_u64(),
        health["responses_validated"].as_u64(),
        health["request_failures"].as_u64(),
        health["request_cancelled"].as_u64(),
    ) {
        (Some(requests), Some(validated), Some(failed), Some(cancelled)) => validated
            .checked_add(failed)
            .and_then(|known| known.checked_add(cancelled))
            .is_none_or(|known| known < requests),
        _ => true,
    };
    for (name, metric) in HEALTH_METRICS {
        if has_health
            && (health["counter_scheme"] != 1
                || marked(name)
                || REQUEST_OUTCOME_COUNTERS.contains(name)
                    && (!request_outcomes_covered(health) || pending_outcomes))
        {
            partial.insert((*metric).into());
        }
    }
    if !has_health && has_activity {
        partial.insert("calls".into());
    }
    let exact_attempts = health["counter_scheme"] == 1
        && health.get("api_requests").is_some()
        && !marked("api_requests");
    for name in STATS_COUNTERS {
        if *name == "calls" && exact_attempts {
            continue;
        }
        if has_stats
            && (stats[format!("partial_{name}")] == 1
                || stats["counter_scheme"] != 1
                    && (LEGACY_PARTIAL_STATS.contains(name) || stats.get(*name).is_none()))
            || !has_stats && has_activity
        {
            partial.insert((*name).into());
        }
    }
    if stats["replaced"] == 0 && stats["partial_replaced"] != 1 && stats.get("savedChars").is_none()
    {
        partial.remove("savedChars");
    }
    if health["skip_reasons_partial"]
        .as_bool()
        .unwrap_or(has_health)
    {
        partial.insert("classificationKeptFull".into());
    }
    if partial.contains("savedChars") {
        partial.insert("estimatedTokensSaved".into());
    }
    if partial.contains("elapsedMs") || partial.contains("timed") {
        partial.insert("averageMs".into());
    }
    // Python-era timed counted output outcomes, not API requests. Its ratio
    // has no known request-timing meaning even when both raw counters exist.
    if has_stats && !stats_baseline_is_fresh(stats) {
        partial.insert("averageMs".into());
    }
    partial
}
