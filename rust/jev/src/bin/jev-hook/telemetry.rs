//! Private hook health and completion counters.
use super::*;

pub(super) fn hook_health(data_dir: &Path, outcome: &str, reason: &str) -> Result<(), String> {
    ensure_dir(data_dir)?;
    let logs = data_dir.join("logs");
    ensure_dir(&logs)?;
    let _lock = lock_logs(&logs)?;
    let path = logs.join("hook-health.json");
    let mut health = if path.exists() {
        let metadata = fs::symlink_metadata(&path).map_err(|_| "hook health stat")?;
        if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 4096 {
            return Err("unsafe hook health".into());
        }
        serde_json::from_slice::<Value>(&fs::read(&path).map_err(|_| "hook health read")?)
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
        }
        "seen" => {}
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

pub(super) fn load_stats(path: &Path) -> Result<Value, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(json!({})),
        Err(_) => return Err("stats stat failed".into()),
    };
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 8192 {
        return Err("unsafe stats file".into());
    }
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|_| "stats read failed")?)
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
    let path = logs.join("events.jsonl");
    if path.is_symlink() {
        return Err("linked event log".into());
    }
    let mut options = OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut file = options.open(path).map_err(|_| "event log")?;
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
