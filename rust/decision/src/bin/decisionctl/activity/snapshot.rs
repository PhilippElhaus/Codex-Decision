//! Bounded aggregate reads and consumer metrics; receipts are never opened.
use super::*;
use codex_decision::activity_counters::{
    completed_request_minimum, partial_metric_names, validate_health_counters,
    validate_stats_counters, HEALTH_METRICS, STATS_COUNTERS,
};
#[path = "../../decision-hook/strict_json.rs"]
mod strict_json;

pub(super) fn load(path: &Path, limit: u64) -> Result<Value, String> {
    if path.file_name().and_then(|value| value.to_str()) == Some("stats.json") {
        return super::publication::read_stats(path.parent().ok_or("invalid activity scope")?);
    }
    let metadata = match fs::symlink_metadata(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(json!({})),
        Err(_) => return Err("activity stat failed".into()),
        Ok(metadata) => metadata,
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > limit {
        return Err("unsafe activity file".into());
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let file = options.open(path).map_err(|_| "activity open failed")?;
    let opened = file.metadata().map_err(|_| "activity stat failed")?;
    if !opened.is_file() || opened.len() > limit {
        return Err("unsafe activity file".into());
    }
    let mut bytes = Vec::new();
    file.take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "activity read failed")?;
    if bytes.len() as u64 > limit {
        return Err("unsafe activity file".into());
    }
    strict_json::parse(&bytes).map_err(|_| "invalid activity file".into())
}

pub(super) fn metrics(stats: &Value, health: &Value) -> Result<Value, String> {
    validate_stats_counters(stats)?;
    if !health.is_object() {
        return Err("invalid activity health".into());
    }
    validate_health_counters(health)?;
    if codex_decision::activity_counters::counters_conflict(stats, health) {
        return Err("inconsistent activity counters".into());
    }
    for name in [
        "last_skip",
        "last_error",
        "last_skip_detail",
        "hook_version",
    ] {
        if health
            .get(name)
            .is_some_and(|value| value.as_str().is_none_or(|value| value.len() > 80))
        {
            return Err("invalid activity metadata".into());
        }
    }
    let active = stats.as_object().is_some_and(|value| !value.is_empty())
        || health.as_object().is_some_and(|value| !value.is_empty());
    let unknown = if active { Value::Null } else { json!(0) };
    let counter =
        |value: &Value, name: &str| value.get(name).cloned().unwrap_or_else(|| unknown.clone());
    let mut result = serde_json::Map::new();
    for name in STATS_COUNTERS {
        result.insert((*name).into(), counter(stats, name));
    }
    for (name, metric) in HEALTH_METRICS {
        result.insert((*metric).into(), counter(health, name));
    }
    let recorded_calls = stats["calls"].as_u64().unwrap_or(0);
    let completed_calls = completed_request_minimum(stats);
    result.insert(
        "calls".into(),
        json!(health["api_requests"]
            .as_u64()
            .unwrap_or(recorded_calls)
            .max(recorded_calls)),
    );
    for (name, metric) in [
        ("responses_received", "responsesReceived"),
        ("responses_validated", "responsesValidated"),
    ] {
        if let Some(value) = health[name].as_u64() {
            result.insert(metric.into(), json!(value.max(completed_calls)));
        }
    }
    if stats["replaced"] == 0 && stats["partial_replaced"] != 1 && stats.get("savedChars").is_none()
    {
        result.insert("savedChars".into(), json!(0));
    }
    result.insert(
        "classificationKeptFull".into(),
        health
            .get("skip_counts")
            .map(|counts| {
                counts
                    .get("choice_kept_full_output")
                    .cloned()
                    .unwrap_or(json!(0))
            })
            .unwrap_or_else(|| unknown.clone()),
    );
    for (name, key) in [
        ("skip_counts", "skipCounts"),
        ("skip_details", "skipDetails"),
    ] {
        result.insert(key.into(), health.get(name).cloned().unwrap_or(json!({})));
    }
    let candidate_reasons = Value::Object(
        stats
            .as_object()
            .unwrap()
            .iter()
            .filter_map(|(key, value)| {
                key.strip_prefix("candidate_")
                    .map(|key| (key.into(), value.clone()))
            })
            .collect(),
    );
    validate_health_counters(&json!({"skip_counts": candidate_reasons}))?;
    result.insert("candidateReasons".into(), candidate_reasons);
    result.insert(
        "partialCounters".into(),
        json!(partial_metric_names(stats, health, active)),
    );
    result.insert(
        "estimatedTokensSaved".into(),
        result["savedChars"]
            .as_u64()
            .map(|saved| json!(saved / 4 + u64::from(saved % 4 >= 2)))
            .unwrap_or_else(|| unknown.clone()),
    );
    result.insert(
        "averageMs".into(),
        match (stats["elapsedMs"].as_u64(), stats["timed"].as_u64()) {
            _ if partial_metric_names(stats, health, active).contains("averageMs") => Value::Null,
            (Some(elapsed), Some(timed)) if timed > 0 => {
                json!(rounded_average(elapsed, timed))
            }
            (_, Some(0)) => json!(0),
            _ => unknown.clone(),
        },
    );
    for (name, key) in [
        ("skip_reasons_partial", "skipReasonsPartial"),
        ("skip_details_partial", "skipDetailsPartial"),
    ] {
        result.insert(
            key.into(),
            json!(health[name]
                .as_bool()
                .unwrap_or(health.as_object().is_some_and(|value| !value.is_empty()))),
        );
    }
    Ok(Value::Object(result))
}

fn rounded_average(elapsed: u64, timed: u64) -> u64 {
    if timed == 0 {
        return 0;
    }
    elapsed / timed + u64::from(elapsed % timed >= timed / 2 + timed % 2)
}

#[cfg(test)]
#[path = "average_tests.rs"]
mod average_tests;
