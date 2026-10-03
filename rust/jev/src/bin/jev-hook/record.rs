//! Atomic publication of receipts, batches, totals, and completion events.
use super::*;

#[allow(clippy::too_many_arguments)] // Keep event and decision evidence explicit at the write boundary.
pub(super) fn record(
    data_dir: &Path,
    event: &Value,
    route: &str,
    status: &str,
    source: &str,
    visible: &str,
    lines: &[SourceLine],
    decisions: &[codex_jev::LineDecision],
    batches: &[BatchRecord],
    gate_record: Option<&BatchRecord>,
    config: &Config,
    receipt_id: &str,
    snapshot_id: &str,
) -> Result<(), String> {
    let gate_elapsed_ms = gate_record.map(|gate| gate.elapsed_ms);
    ensure_dir(data_dir)?;
    let logs = data_dir.join("logs");
    ensure_dir(&logs)?;
    let _lock = lock_logs(&logs)?;
    let now = Utc::now();
    let session = event
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let session_hash = format!("{:x}", Sha256::digest(session.as_bytes()));
    let folder = logs.join(format!(
        "{}-{}",
        now.format("%Y-%m-%d"),
        &session_hash[..10]
    ));
    ensure_dir(&folder)?;
    let id = receipt_id;
    let original_hash = format!("{:x}", Sha256::digest(source.as_bytes()));
    let seen = lines.len();
    let judged = decisions
        .iter()
        .filter(|row| row.batch_id.is_some())
        .count();
    let omitted = decisions
        .iter()
        .filter(|row| row.action == Action::Omit)
        .count();
    let protected = decisions
        .iter()
        .filter(|row| row.protected_reason.is_some())
        .count();
    let unjudged = lines
        .iter()
        .zip(decisions)
        .filter(|(line, decision)| {
            line.eligible && line.protected_reason.is_none() && decision.batch_id.is_none()
        })
        .count();
    let relevance_judged = decisions
        .iter()
        .filter(|row| row.p_task_relevant.is_some())
        .count();
    let below_omit_cutoff = decisions
        .iter()
        .filter(|row| row.reason == "below_omit_cutoff")
        .count();
    let relevance_kept = decisions
        .iter()
        .filter(|row| row.reason == "task_relevant")
        .count();
    let summary = json!({"version":3,"id":id,"at":now.to_rfc3339(),"filter":route,"status":status,
        "reason":if config.mode == "observe" { "observe" } else { "relevance_policy" },
        "tool":event.get("tool_name"),"capsule_chars":visible.chars().count(),
        "elapsed_ms":batches.iter().map(|batch| batch.elapsed_ms).sum::<u64>() + gate_elapsed_ms.unwrap_or(0),
        "source_sha256":original_hash,"lines_seen":seen,"lines_judged":judged,"lines_kept":seen-omitted,
        "lines_omitted":omitted,"lines_protected":protected,"lines_unjudged":unjudged,
        "lines_relevance_judged":relevance_judged,"lines_below_omit_cutoff":below_omit_cutoff,
        "lines_relevance_kept":relevance_kept,"search_relevance_guard":false,
        "relevance_policy":config.policy,
        "output_kind":gate_record.and_then(|record| record.response.pointer("/answers/output_kind/choice")),
        "api_usage":{"input_tokens":gate_record.into_iter().chain(batches.iter()).filter_map(|record|record.response.pointer("/usage/input_tokens").and_then(Value::as_u64)).sum::<u64>(),
            "output_tokens":gate_record.into_iter().chain(batches.iter()).filter_map(|record|record.response.pointer("/usage/output_tokens").and_then(Value::as_u64)).sum::<u64>()},
        "requests":batches.len()+usize::from(gate_elapsed_ms.is_some()),
        "choice_gate_ran":gate_elapsed_ms.is_some(),
        "original_chars":source.chars().count(),"visible_chars":visible.chars().count()});
    let receipt = json!({"version":3,"manifest":summary,"tool":event.get("tool_name"),
        "tool_input":event.get("tool_input"),"initial_output":source,
        "visible_output":if status == "replace" { Some(visible) } else { None },
        "decisions":decisions});
    let receipt_bytes = serde_json::to_vec(&receipt).map_err(|_| "receipt encoding")?;
    if receipt_bytes.len() > MAX_RECEIPT_BYTES {
        return Err("receipt too large".into());
    }
    let mut artifacts = vec![(folder.join(format!("receipt-{id}.json")), receipt_bytes)];
    for batch in gate_record.into_iter().chain(batches.iter()) {
        let bytes = serde_json::to_vec(&json!({"version":2,"receipt_id":id,"batch":batch}))
            .map_err(|_| "batch encoding")?;
        if bytes.len() > 2 * 1024 * 1024 {
            return Err("batch record too large".into());
        }
        artifacts.push((folder.join(format!("batch-{id}-{}.json", batch.id)), bytes));
    }
    let last_batch = batches.last().ok_or("missing batch")?;
    let snapshot = line_snapshot(
        id,
        snapshot_id,
        route,
        status,
        lines,
        decisions,
        last_batch,
        batches.len(),
        batches.len(),
    );
    let event_path = logs.join("events.jsonl");
    if event_path.is_symlink() {
        return Err("linked event log".into());
    }
    let mut event_options = OpenOptions::new();
    event_options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        event_options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let mut event_file = event_options.open(&event_path).map_err(|_| "event log")?;
    let event_size = event_file.metadata().map_err(|_| "event log stat")?.len();
    if !event_file
        .metadata()
        .map_err(|_| "event log stat")?
        .is_file()
    {
        return Err("unsafe event log".into());
    }
    let stats_path = data_dir.join("stats.json");
    let mut stats = load_stats(&stats_path)?;
    for (key, increment) in [
        (
            "calls",
            batches.len() as u64 + u64::from(gate_elapsed_ms.is_some()),
        ),
        ("completed", 1),
        ("replaced", u64::from(status == "replace")),
        (
            "timed",
            batches.len() as u64 + u64::from(gate_elapsed_ms.is_some()),
        ),
        (
            "elapsedMs",
            batches.iter().map(|batch| batch.elapsed_ms).sum::<u64>()
                + gate_elapsed_ms.unwrap_or(0),
        ),
        (
            "savedChars",
            if status == "replace" {
                source
                    .chars()
                    .count()
                    .saturating_sub(visible.chars().count()) as u64
            } else {
                0
            },
        ),
        ("linesSeen", seen as u64),
        ("linesJudged", judged as u64),
        ("linesKept", (seen - omitted) as u64),
        ("linesOmitted", omitted as u64),
        ("linesProtected", protected as u64),
        ("linesUnjudged", unjudged as u64),
        ("linesRelevanceJudged", relevance_judged as u64),
        ("linesBelowOmitCutoff", below_omit_cutoff as u64),
        ("linesRelevanceKept", relevance_kept as u64),
    ] {
        stats[key] = json!(stats
            .get(key)
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .saturating_add(increment));
    }
    let snapshot_path = logs.join("latest-decision.json");
    let snapshot_bytes = serde_json::to_vec(&snapshot).map_err(|_| "snapshot encoding")?;
    if snapshot_bytes.len() > PANEL_SNAPSHOT_MAX_BYTES {
        return Err("panel snapshot too large".into());
    }
    let stats_bytes = serde_json::to_vec(&stats).map_err(|_| "stats encoding")?;
    let previous_stats = private_backup(&stats_path, 8192)?;
    let previous_snapshot = private_backup(&snapshot_path, PANEL_SNAPSHOT_MAX_BYTES)?;
    let mut created = Vec::new();
    let result = (|| -> Result<(), String> {
        remaining()?;
        for (path, bytes) in artifacts {
            write_private(&path, &bytes, false)?;
            created.push(path);
        }
        write_private(&stats_path, &stats_bytes, true)?;
        write_private(&snapshot_path, &snapshot_bytes, true)?;
        // Append the completion event only after every required artifact exists.
        // No fallible operation may cancel the output after this commit point.
        writeln!(event_file, "{}", summary).map_err(|_| "event log write")?;
        event_file.sync_all().map_err(|_| "event log sync")?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = event_file.set_len(event_size);
        restore_private(&stats_path, previous_stats);
        restore_private(&snapshot_path, previous_snapshot);
        for path in created {
            let _ = fs::remove_file(path);
        }
        return Err(error);
    }
    if !config.never_delete_logs {
        prune(&logs, config.log_limit_mb * 1_000_000);
    }
    Ok(())
}
