//! Private hook health and completion counters.
use super::*;

pub(super) fn hook_health(data_dir: &Path, outcome: &str, reason: &str) -> Result<(), String> {
    ensure_dir(data_dir)?;
    let logs = data_dir.join("logs");
    ensure_dir(&logs)?;
    let _lock = if outcome == "error" {
        cleanup_log_lock(&logs)?
    } else {
        lock_logs(&logs)?
    };
    let path = logs.join("hook-health.json");
    let mut health = if path.exists() {
        let metadata = fs::symlink_metadata(&path).map_err(|_| "hook health stat")?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
            return Err("unsafe hook health".into());
        }
        serde_json::from_slice::<Value>(&read_bounded(&path, 4096).map_err(|_| "hook health read")?)
            .map_err(|_| "invalid hook health")?
    } else {
        json!({})
    };
    if !health.is_object() {
        return Err("invalid hook health".into());
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
        "success" => health["last_success_ms"] = json!(now),
        "error" => {
            health["last_error_ms"] = json!(now);
            health["last_error"] = json!(reason);
        }
        "skip" => {
            health["last_skip_ms"] = json!(now);
            health["last_skip"] = json!(reason);
            let count = health["skipped"].as_u64().unwrap_or(0).saturating_add(1);
            health["skipped"] = json!(count);
            if health["skip_counts"].is_null() {
                health["skip_counts"] = json!({});
            }
            let counts = health["skip_counts"]
                .as_object_mut()
                .ok_or("invalid skip counts")?;
            let count = counts
                .get(reason)
                .and_then(Value::as_u64)
                .unwrap_or(0)
                .saturating_add(1);
            counts.insert(reason.into(), json!(count));
        }
        "seen" => {
            health["seen"] = json!(health["seen"].as_u64().unwrap_or(0).saturating_add(1));
        }
        _ => return Err("invalid hook health outcome".into()),
    }
    write_private(
        &path,
        &serde_json::to_vec(&health).map_err(|_| "hook health encoding")?,
        true,
    )
}

pub(super) fn skip(data_dir: &Path, reason: &str) -> Result<Value, String> {
    hook_health(data_dir, "skip", reason)?;
    Ok(json!({}))
}

// Only the classification stage signals composer activity. Relevance batches
// publish line decisions separately and must not retrigger the blue pulse.
pub(super) fn classification_start(data_dir: &Path) -> Result<(), String> {
    let logs = data_dir.join("logs");
    ensure_dir(&logs)?;
    let _lock = lock_logs(&logs)?;
    let mut file = open_event_log(&logs)?;
    writeln!(
        file,
        "{}",
        json!({"version":3,"at":Utc::now().to_rfc3339(),
            "status":"classifying","reason":"classification_start","requests":0})
    )
    .map_err(|_| "event log write".into())
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
        serde_json::from_slice(&read_bounded(path, 8192).map_err(|_| "stats read failed")?)
            .map_err(|_| "invalid stats file")?;
    let object = value.as_object().ok_or("invalid stats file")?;
    if object.values().any(|item| item.as_u64().is_none()) {
        return Err("invalid stats value".into());
    }
    Ok(value)
}

pub(super) fn record_gate_skip(
    data_dir: &Path,
    event: &Value,
    source_chars: usize,
    gate: &BatchRecord,
    kind: &str,
    reason: &str,
) -> Result<(), String> {
    let elapsed_ms = gate.elapsed_ms;
    ensure_dir(data_dir)?;
    let logs = data_dir.join("logs");
    ensure_dir(&logs)?;
    let _lock = lock_logs(&logs)?;
    let stats_path = data_dir.join("stats.json");
    let mut stats = load_stats(&stats_path)?;
    let mut file = open_event_log(&logs)?;
    writeln!(
        file,
        "{}",
        json!({"version":3,"at":Utc::now().to_rfc3339(),
        "status":"skip","reason":reason,"output_kind":kind,
        "classification":gate.response["answers"]["output_kind"],"api_usage":gate.response.get("usage"),"filter":"output",
        "tool":event.get("tool_name"),"original_chars":source_chars,"capsule_chars":source_chars,
        "elapsed_ms":elapsed_ms,"requests":1})
    )
    .map_err(|_| "event log write")?;
    for (name, amount) in [
        ("calls", 1),
        ("completed", 0),
        ("replaced", 0),
        ("timed", 1),
        ("elapsedMs", elapsed_ms),
    ] {
        stats[name] = json!(stats
            .get(name)
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .saturating_add(amount));
    }
    write_private(
        &stats_path,
        &serde_json::to_vec(&stats).map_err(|_| "stats encoding")?,
        true,
    )
}
