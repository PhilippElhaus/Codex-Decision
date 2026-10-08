//! Private hook health and completion counters.
use super::*;

use codex_decision::activity_counters::{
    bootstrap_health_counters, validate_health_counters, validate_stats_counters,
};
pub(super) use codex_decision::activity_counters::{checked_counter_add, prepare_stats_counters};
#[cfg(test)]
use codex_decision::activity_counters::{HEALTH_COUNTERS, LEGACY_PARTIAL_STATS, STATS_COUNTERS};
#[path = "telemetry/gate.rs"]
mod gate;
pub(super) use gate::record_gate_skip;
#[path = "telemetry/history.rs"]
mod history;
pub(super) use history::load_activity_stats;

pub(super) fn hook_health(data_dir: &Path, outcome: &str, reason: &str) -> Result<(), String> {
    hook_health_detail(data_dir, outcome, reason, None)
}

fn hook_health_detail(
    data_dir: &Path,
    outcome: &str,
    reason: &str,
    detail: Option<&str>,
) -> Result<(), String> {
    ensure_dir(data_dir)?;
    let logs = data_dir.join("logs");
    ensure_dir(&logs)?;
    let _lock = if matches!(
        outcome,
        "error"
            | "success"
            | "request_cancelled"
            | "response_validated"
            | "response_invalid"
            | "request_failed"
    ) {
        cleanup_log_lock(&logs)?
    } else {
        lock_logs(&logs)?
    };
    let path = logs.join("hook-health.json");
    let existed = path.exists();
    let mut health = if existed {
        let metadata = fs::symlink_metadata(&path).map_err(|_| "hook health stat")?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
            return Err("unsafe hook health".into());
        }
        strict_json::parse(&read_bounded(&path, 4096).map_err(|_| "hook health read")?)
            .map_err(|_| "invalid hook health")?
    } else {
        json!({"errors":0})
    };
    if !health.is_object() {
        return Err("invalid hook health".into());
    }
    let stats_path = data_dir.join("stats.json");
    let had_stats = stats_path.exists();
    let retained = if !existed && !had_stats {
        history::retained_stats(&logs)?
    } else {
        None
    };
    let recorded_requests = if !existed && had_stats {
        load_stats(&stats_path)?["calls"].as_u64()
    } else {
        retained.as_ref().and_then(|stats| stats["calls"].as_u64())
    };
    if bootstrap_health_counters(
        &mut health,
        existed,
        had_stats || retained.is_some(),
        recorded_requests,
    )? {
        // An explicit zero ledger distinguishes a fresh session from a lost old file.
        let mut zero_stats = json!({});
        prepare_stats_counters(&mut zero_stats, false)?;
        write_private(
            &stats_path,
            &serde_json::to_vec(&zero_stats).map_err(|_| "stats encoding")?,
            false,
        )?;
    } else if let Some(stats) = retained {
        write_private(
            &stats_path,
            &serde_json::to_vec(&stats).map_err(|_| "stats encoding")?,
            false,
        )?;
    }
    let now = Utc::now().timestamp_millis().max(
        health["last_seen_ms"]
            .as_i64()
            .unwrap_or(0)
            .saturating_add(1),
    );
    health["version"] = json!(1);
    health["hook_version"] = json!(env!("CARGO_PKG_VERSION"));
    health["last_seen_ms"] = json!(now);
    match outcome {
        "request" => {
            let previous = match health["api_requests"].as_u64() {
                Some(count) => count,
                None => load_stats(&data_dir.join("stats.json"))?["calls"]
                    .as_u64()
                    .unwrap_or(0),
            };
            health["api_requests"] = json!(checked_counter_add(previous, 1)?);
        }
        "request_cancelled" => {
            if reason != "hook deadline before send" {
                return Err("invalid request cancellation reason".into());
            }
            let previous = health["request_cancelled"].as_u64().unwrap_or(0);
            health["request_cancelled"] = json!(checked_counter_add(previous, 1)?);
        }
        "success" => health["last_success_ms"] = json!(now),
        "response_validated" | "response_invalid" | "request_failed" => {
            for (name, increment) in [
                ("responses_received", u64::from(outcome != "request_failed")),
                (
                    "responses_validated",
                    u64::from(outcome == "response_validated"),
                ),
                (
                    "request_failures",
                    u64::from(outcome != "response_validated"),
                ),
            ] {
                health[name] = json!(checked_counter_add(
                    health[name].as_u64().unwrap_or(0),
                    increment
                )?);
            }
        }
        "error" => {
            health["last_error_ms"] = json!(now);
            health["last_error"] = json!(reason);
            health["errors"] = json!(checked_counter_add(
                health["errors"].as_u64().unwrap_or(0),
                1
            )?);
        }
        "skip" => {
            health["last_skip_ms"] = json!(now);
            health["last_skip"] = json!(reason);
            let count = checked_counter_add(health["skipped"].as_u64().unwrap_or(0), 1)?;
            health["skipped"] = json!(count);
            if health["skip_counts"].is_null() {
                health["skip_counts"] = json!({});
            }
            let counts = health["skip_counts"]
                .as_object_mut()
                .ok_or("invalid skip counts")?;
            let count =
                checked_counter_add(counts.get(reason).and_then(Value::as_u64).unwrap_or(0), 1)?;
            counts.insert(reason.into(), json!(count));
            health.as_object_mut().unwrap().remove("last_skip_detail");
            if let Some(detail) = detail {
                health["last_skip_detail"] = json!(detail);
                if health["skip_details"].is_null() {
                    health["skip_details"] = json!({});
                }
                let details = health["skip_details"]
                    .as_object_mut()
                    .ok_or("invalid skip details")?;
                let count = details.get(detail).and_then(Value::as_u64).unwrap_or(0);
                details.insert(detail.into(), json!(checked_counter_add(count, 1)?));
            }
        }
        "seen" => {
            health["seen"] = json!(checked_counter_add(
                health["seen"].as_u64().unwrap_or(0),
                1
            )?);
        }
        _ => return Err("invalid hook health outcome".into()),
    }
    validate_health_counters(&health)?;
    let bytes = serde_json::to_vec(&health).map_err(|_| "hook health encoding")?;
    if bytes.len() > 4096 {
        return Err("hook health too large".into());
    }
    write_private(&path, &bytes, true)
}

pub(super) fn request_result(
    data_dir: &Path,
    received: bool,
    validated: bool,
) -> Result<(), String> {
    if validated && !received {
        return Err("invalid request result".into());
    }
    hook_health(
        data_dir,
        if validated {
            "response_validated"
        } else if received {
            "response_invalid"
        } else {
            "request_failed"
        },
        "",
    )
}

#[cfg(test)]
#[path = "telemetry_tests.rs"]
mod tests;

pub(super) fn skip(data_dir: &Path, reason: &str) -> Result<Value, String> {
    hook_health(data_dir, "skip", reason)?;
    Ok(json!({}))
}

pub(super) fn skip_with_detail(
    data_dir: &Path,
    reason: &str,
    detail: &str,
) -> Result<Value, String> {
    if !matches!(
        detail,
        "protected_output" | "protected_command" | "protected_input"
    ) {
        return Err("invalid skip detail".into());
    }
    hook_health_detail(data_dir, "skip", reason, Some(detail))?;
    Ok(json!({}))
}

// Only the classification stage signals composer activity. Relevance batches
// publish line decisions separately and must not retrigger the blue pulse.
pub(super) fn classification_start(data_dir: &Path, never_delete_logs: bool) -> Result<(), String> {
    let logs = data_dir.join("logs");
    ensure_dir(&logs)?;
    let _lock = lock_logs(&logs)?;
    let mut bytes = serde_json::to_vec(&json!({"version":3,"at":Utc::now().to_rfc3339(),
        "status":"classifying","reason":"classification_start","requests":0}))
    .map_err(|_| "event encoding")?;
    bytes.push(b'\n');
    compact_events_before_append(&logs, bytes.len(), never_delete_logs)?;
    let mut file = open_event_log(&logs)?;
    file.write_all(&bytes).map_err(|_| "event log write".into())
}

pub(super) fn load_stats(path: &Path) -> Result<Value, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(_) => return Err("stats stat failed".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 8192 {
        return Err("unsafe stats file".into());
    }
    let value: Value =
        strict_json::parse(&read_bounded(path, 8192).map_err(|_| "stats read failed")?)
            .map_err(|_| "invalid stats file")?;
    validate_stats_counters(&value)?;
    Ok(value)
}
