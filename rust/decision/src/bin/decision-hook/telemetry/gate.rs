//! Atomic publication of classification-only completion metadata.
use super::*;

pub(crate) fn record_gate_skip(
    data_dir: &Path,
    event: &Value,
    source_chars: usize,
    gate: &BatchRecord,
    kind: &str,
    reason: &str,
    never_delete_logs: bool,
) -> Result<(), String> {
    let elapsed_ms = gate.elapsed_ms;
    ensure_dir(data_dir)?;
    let logs = data_dir.join("logs");
    ensure_dir(&logs)?;
    let _lock = lock_logs(&logs)?;
    let stats_path = data_dir.join("stats.json");
    let mut stats = load_activity_stats(data_dir)?;
    let previous_stats = private_backup(&stats_path, 8192)?;
    let mut event_bytes = serde_json::to_vec(&json!({"version":3,"at":Utc::now().to_rfc3339(),
        "status":"skip","reason":reason,"output_kind":kind,
        "classification":gate.response["answers"]["output_kind"],"api_usage":gate.response.get("usage"),"filter":"output",
        "tool":event.get("tool_name"),"original_chars":source_chars,"capsule_chars":source_chars,
        "elapsed_ms":elapsed_ms,"requests":1})).map_err(|_| "event encoding")?;
    event_bytes.push(b'\n');
    for (name, amount) in [
        ("calls", 1),
        ("completed", 0),
        ("replaced", 0),
        ("timed", 1),
        ("elapsedMs", elapsed_ms),
    ] {
        stats[name] = json!(checked_counter_add(
            stats.get(name).and_then(Value::as_u64).unwrap_or(0),
            amount
        )?);
    }
    let stats_bytes = serde_json::to_vec(&stats).map_err(|_| "stats encoding")?;
    if stats_bytes.len() > 8192 {
        return Err("stats too large".into());
    }
    compact_events_before_append(&logs, event_bytes.len(), never_delete_logs)?;
    let mut file = open_event_log(&logs)?;
    let event_size = file.metadata().map_err(|_| "event log stat")?.len();
    let id = Uuid::new_v4().simple().to_string();
    let session = event["session_id"].as_str().unwrap_or("unknown");
    let hash = format!("{:x}", Sha256::digest(session.as_bytes()));
    let folder = format!("{}-{}", Utc::now().format("%Y-%m-%d"), &hash[..10]);
    let publication = record::journal::Publication::begin(
        data_dir,
        &folder,
        &id,
        previous_stats,
        &stats_bytes,
        None,
        vec![],
        event_size,
        &event_bytes,
    )?;
    let published = (|| -> Result<(), String> {
        remaining()?;
        write_private(&stats_path, &stats_bytes, true)?;
        remaining()?;
        file.write_all(&event_bytes)
            .map_err(|_| "event log write")?;
        file.sync_all().map_err(|_| "event log sync")?;
        publication.commit()?;
        Ok(())
    })();
    if let Err(error) = published {
        publication.rollback()?;
        return Err(error);
    }
    publication.committed();
    Ok(())
}
