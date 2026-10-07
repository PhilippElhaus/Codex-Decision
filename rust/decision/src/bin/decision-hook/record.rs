//! Atomic publication of receipts, batches, totals, and completion events.
use super::*;

#[path = "record/staging.rs"]
mod staging;
use staging::{cleanup_pending_batches, PreparedBatches};

#[allow(clippy::too_many_arguments)] // Keep event and decision evidence explicit at the write boundary.
pub(super) fn record(
    data_dir: &Path,
    event: &Value,
    route: &str,
    status: &str,
    reason: &str,
    source: &str,
    visible: &str,
    lines: &[SourceLine],
    decisions: &[codex_decision::LineDecision],
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
    let prepared = PreparedBatches::new(&logs, receipt_id, gate_record, batches)?;
    let last_batch = batches.last().ok_or("missing batch")?;
    let snapshot = prepare_line_snapshot(
        receipt_id,
        snapshot_id,
        route,
        status,
        lines,
        decisions,
        last_batch,
        batches.len(),
        batches.len(),
        usize::from(gate_record.is_some()),
    )?;
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
    let original_chars = source.chars().count();
    let visible_chars = visible.chars().count();
    let elapsed_ms =
        batches.iter().map(|batch| batch.elapsed_ms).sum::<u64>() + gate_elapsed_ms.unwrap_or(0);
    let session = event
        .get("session_id")
        .and_then(Value::as_str)
        .unwrap_or("unknown");
    let session_hash = format!("{:x}", Sha256::digest(session.as_bytes()));
    let id = receipt_id;
    let mut summary = json!({"version":3,"id":id,"at":"","filter":route,"status":status,
        "reason":reason,
        "tool":event.get("tool_name"),"capsule_chars":visible_chars,
        "elapsed_ms":elapsed_ms,
        "source_sha256":original_hash,"lines_seen":seen,"lines_judged":judged,"lines_kept":seen-omitted,
        "lines_omitted":omitted,"lines_protected":protected,"lines_unjudged":unjudged,
        "lines_relevance_judged":relevance_judged,"lines_below_omit_cutoff":below_omit_cutoff,
        "lines_relevance_kept":relevance_kept,"search_relevance_guard":false,
        "relevance_policy":config.policy,"provider":if config.model == "gpt-6-luna" {"openai"} else {"typesafe"},"model":config.model,
        "output_kind":gate_record.and_then(|record| record.response.pointer("/answers/output_kind/choice"))
            .or_else(|| batches.first().and_then(|record| record.request.pointer("/state/output_kind"))),
        "routing":if gate_record.is_some() {"classified"} else {"validated_format"},
        "api_usage":{"input_tokens":gate_record.into_iter().chain(batches.iter()).filter_map(|record|record.response.pointer("/usage/input_tokens").and_then(Value::as_u64)).sum::<u64>(),
            "output_tokens":gate_record.into_iter().chain(batches.iter()).filter_map(|record|record.response.pointer("/usage/output_tokens").and_then(Value::as_u64)).sum::<u64>()},
        "requests":batches.len()+usize::from(gate_elapsed_ms.is_some()),
        "choice_gate_ran":gate_elapsed_ms.is_some(),
        "original_chars":original_chars,"visible_chars":visible_chars});
    let receipt = prepare_receipt(
        &summary,
        event,
        source,
        if status == "replace" {
            Some(visible)
        } else {
            None
        },
        decisions,
    )?;
    let _lock = lock_logs(&logs)?;
    cleanup_pending_batches(&logs);
    let now = Utc::now();
    let folder = logs.join(format!(
        "{}-{}",
        now.format("%Y-%m-%d"),
        &session_hash[..10]
    ));
    ensure_dir(&folder)?;
    let timestamp = now.to_rfc3339();
    summary["at"] = json!(timestamp);
    let receipt_bytes = receipt.finish(&timestamp)?;
    let artifacts = vec![(folder.join(format!("receipt-{id}.json")), receipt_bytes)];
    let mut event_file = open_event_log(&logs)?;
    let event_size = event_file.metadata().map_err(|_| "event log stat")?.len();
    let stats_path = data_dir.join("stats.json");
    let mut stats = load_stats(&stats_path)?;
    if status == "candidate" {
        let key = format!("candidate_{reason}");
        stats[&key] = json!(stats
            .get(&key)
            .and_then(Value::as_u64)
            .unwrap_or(0)
            .saturating_add(1));
    }
    for (key, increment) in [
        (
            "calls",
            batches.len() as u64 + u64::from(gate_elapsed_ms.is_some()),
        ),
        ("completed", 1),
        ("candidates", u64::from(status == "candidate")),
        ("kept", u64::from(status == "keep")),
        ("replaced", u64::from(status == "replace")),
        (
            "timed",
            batches.len() as u64 + u64::from(gate_elapsed_ms.is_some()),
        ),
        ("elapsedMs", elapsed_ms),
        (
            "savedChars",
            if status == "replace" {
                original_chars.saturating_sub(visible_chars) as u64
            } else {
                0
            },
        ),
        ("linesSeen", seen as u64),
        ("linesJudged", judged as u64),
        ("linesKept", (seen - omitted) as u64),
        ("linesOmitted", omitted as u64),
        (
            "linesActuallyOmitted",
            if status == "replace" {
                omitted as u64
            } else {
                0
            },
        ),
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
    let snapshot_bytes = snapshot.finish(&Utc::now().to_rfc3339())?;
    let stats_bytes = serde_json::to_vec(&stats).map_err(|_| "stats encoding")?;
    let previous_stats = private_backup(&stats_path, 8192)?;
    let previous_snapshot = private_backup(&snapshot_path, PANEL_SNAPSHOT_MAX_BYTES)?;
    let mut created = Vec::new();
    let result = (|| -> Result<(), String> {
        remaining()?;
        for (path, bytes) in artifacts {
            remaining()?;
            write_private(&path, &bytes, false)?;
            created.push(path);
        }
        prepared.publish(&folder, id, &mut created)?;
        remaining()?;
        write_private(&stats_path, &stats_bytes, true)?;
        remaining()?;
        write_private(&snapshot_path, &snapshot_bytes, true)?;
        // Append the completion event only after every required artifact exists.
        // No fallible operation may cancel the output after this commit point.
        remaining()?;
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
