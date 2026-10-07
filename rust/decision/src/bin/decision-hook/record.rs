//! Atomic publication of receipts, batches, totals, and completion events.
use super::*;

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
    let mut snapshot = line_snapshot(
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
    );
    let _lock = lock_logs(&logs)?;
    cleanup_pending_batches(&logs);
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
        "reason":reason,
        "tool":event.get("tool_name"),"capsule_chars":visible.chars().count(),
        "elapsed_ms":batches.iter().map(|batch| batch.elapsed_ms).sum::<u64>() + gate_elapsed_ms.unwrap_or(0),
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
        "original_chars":source.chars().count(),"visible_chars":visible.chars().count()});
    let receipt = json!({"version":3,"manifest":summary,"tool":event.get("tool_name"),
        "tool_input":event.get("tool_input"),"initial_output":source,
        "visible_output":if status == "replace" { Some(visible) } else { None },
        "decisions":decisions});
    let receipt_bytes = serde_json::to_vec(&receipt).map_err(|_| "receipt encoding")?;
    if receipt_bytes.len() > MAX_RECEIPT_BYTES {
        return Err("receipt too large".into());
    }
    let artifacts = vec![(folder.join(format!("receipt-{id}.json")), receipt_bytes)];
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
    snapshot["at"] = json!(Utc::now().to_rfc3339());
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

// Immutable API evidence can be encoded and synced without the session lock.
// Publication links the same verified bytes while the existing transaction owns
// the lock. Dropping the preparation removes only its own pending paths.
struct PreparedBatches {
    files: Vec<(usize, PathBuf)>,
}

impl PreparedBatches {
    fn new(
        logs: &Path,
        receipt_id: &str,
        gate: Option<&BatchRecord>,
        batches: &[BatchRecord],
    ) -> Result<Self, String> {
        let mut prepared = Self { files: Vec::new() };
        for batch in gate.into_iter().chain(batches.iter()) {
            remaining()?;
            let bytes =
                serde_json::to_vec(&json!({"version":2,"receipt_id":receipt_id,"batch":batch}))
                    .map_err(|_| "batch encoding")?;
            if bytes.len() > 2 * 1024 * 1024 {
                return Err("batch record too large".into());
            }
            let path = logs.join(format!(".jev-batch-{receipt_id}-{}.pending", batch.id));
            write_private(&path, &bytes, false)?;
            prepared.files.push((batch.id, path));
        }
        Ok(prepared)
    }

    fn publish(
        &self,
        folder: &Path,
        receipt_id: &str,
        created: &mut Vec<PathBuf>,
    ) -> Result<(), String> {
        for (batch_id, source) in &self.files {
            remaining()?;
            let target = folder.join(format!("batch-{receipt_id}-{batch_id}.json"));
            if source.is_symlink() || target.is_symlink() {
                return Err("linked file".into());
            }
            let mut options = OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
            }
            let mut file = options.open(source).map_err(|_| "batch stage open")?;
            if !file.metadata().map_err(|_| "batch stage stat")?.is_file() {
                return Err("unsafe staged batch".into());
            }
            match fs::hard_link(source, &target) {
                Ok(()) => {
                    created.push(target);
                    file.set_modified(std::time::SystemTime::now())
                        .map_err(|_| "batch timestamp")?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::CrossesDevices => {
                    // A mounted log folder can use another filesystem. Keep
                    // its existing private, atomic write behavior.
                    let mut bytes = Vec::new();
                    Read::by_ref(&mut file)
                        .take(2 * 1024 * 1024 + 1)
                        .read_to_end(&mut bytes)
                        .map_err(|_| "batch stage read")?;
                    if bytes.len() > 2 * 1024 * 1024 {
                        return Err("batch record too large".into());
                    }
                    write_private(&target, &bytes, false)?;
                    created.push(target);
                }
                Err(_) => return Err("original already exists".into()),
            }
        }
        Ok(())
    }
}

impl Drop for PreparedBatches {
    fn drop(&mut self) {
        for (_, path) in &self.files {
            let _ = fs::remove_file(path);
        }
    }
}

// A terminated invocation cannot run Drop. Recover only private, recognized
// pending batches older than the hook's entire 60-second outer timeout.
fn cleanup_pending_batches(logs: &Path) {
    let Ok(entries) = fs::read_dir(logs) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name
            .to_str()
            .and_then(|name| name.strip_prefix(".jev-batch-"))
            .and_then(|name| name.strip_suffix(".pending"))
        else {
            continue;
        };
        let Some((id, number)) = name.split_once('-') else {
            continue;
        };
        if id.len() != 32
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || !number
                .parse::<usize>()
                .is_ok_and(|value| value <= MAX_SOURCE_LINES && value.to_string() == number)
        {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_file()
            || metadata.len() > 2 * 1024 * 1024
            || !metadata.modified().is_ok_and(|time| {
                time.elapsed()
                    .is_ok_and(|age| age >= Duration::from_secs(60))
            })
        {
            continue;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            if metadata.uid() != unsafe { libc::geteuid() }
                || metadata.permissions().mode() & 0o077 != 0
            {
                continue;
            }
        }
        let _ = fs::remove_file(path);
    }
}

#[cfg(test)]
mod staging_tests {
    use super::*;

    fn batch(id: usize) -> BatchRecord {
        BatchRecord {
            id,
            target_numbers: vec![1],
            request: json!({"state":{"output_kind":"repetitive_log"}}),
            response: json!({}),
            elapsed_ms: 1,
        }
    }

    #[test]
    fn prepared_batches_keep_exact_bytes_and_remove_only_pending_paths() {
        let root = tempfile::tempdir().unwrap();
        let logs = root.path().join("logs");
        ensure_dir(&logs).unwrap();
        let folder = logs.join("published");
        ensure_dir(&folder).unwrap();
        let id = "a".repeat(32);
        let batches = vec![batch(1), batch(2)];
        let prepared = PreparedBatches::new(&logs, &id, None, &batches).unwrap();
        let mut created = Vec::new();
        prepared.publish(&folder, &id, &mut created).unwrap();
        assert_eq!(created.len(), 2);
        for (record, path) in batches.iter().zip(&created) {
            assert_eq!(
                fs::read(path).unwrap(),
                serde_json::to_vec(&json!({"version":2,"receipt_id":id,"batch":record})).unwrap()
            );
        }
        drop(prepared);
        assert!(created.iter().all(|path| path.is_file()));
        assert!(!fs::read_dir(&logs)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().ends_with(".pending")));
    }

    #[cfg(unix)]
    #[test]
    fn nonregular_pending_batch_is_rejected_without_waiting_for_a_writer() {
        let root = tempfile::tempdir().unwrap();
        let logs = root.path().join("logs");
        ensure_dir(&logs).unwrap();
        let folder = logs.join("published");
        ensure_dir(&folder).unwrap();
        let id = "f".repeat(32);
        let prepared = PreparedBatches::new(&logs, &id, None, &[batch(1)]).unwrap();
        let pending = &prepared.files[0].1;
        fs::remove_file(pending).unwrap();
        use std::os::unix::ffi::OsStrExt;
        let name = std::ffi::CString::new(pending.as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut created = Vec::new();
            let result = prepared.publish(&folder, &id, &mut created);
            sender.send((result.is_err(), created.is_empty())).unwrap();
            drop(prepared);
            drop(root);
        });
        assert_eq!(
            receiver
                .recv_timeout(Duration::from_secs(1))
                .expect("batch publication blocked"),
            (true, true)
        );
    }

    #[test]
    fn recovery_preserves_fresh_unknown_and_linked_content() {
        let root = tempfile::tempdir().unwrap();
        let expired = root
            .path()
            .join(format!(".jev-batch-{}-1.pending", "a".repeat(32)));
        let fresh = root
            .path()
            .join(format!(".jev-batch-{}-2.pending", "b".repeat(32)));
        let unknown = root.path().join(".jev-batch-user-owned-1.pending");
        for path in [&expired, &fresh, &unknown] {
            write_private(path, b"fixture", false).unwrap();
        }
        let old = std::time::SystemTime::now() - Duration::from_secs(61);
        File::open(&expired).unwrap().set_modified(old).unwrap();
        File::open(&unknown).unwrap().set_modified(old).unwrap();
        #[cfg(unix)]
        let linked = {
            let path = root
                .path()
                .join(format!(".jev-batch-{}-3.pending", "c".repeat(32)));
            std::os::unix::fs::symlink(&unknown, &path).unwrap();
            path
        };
        cleanup_pending_batches(root.path());
        assert!(!expired.exists());
        assert!(fresh.is_file());
        assert!(unknown.is_file());
        #[cfg(unix)]
        assert!(linked.is_symlink());
    }

    #[test]
    fn failed_batch_publication_restores_receipt_transaction_and_pending_files() {
        let root = tempfile::tempdir().unwrap();
        let logs = root.path().join("logs");
        ensure_dir(&logs).unwrap();
        let config_path = root.path().join("config.json");
        write_private(&config_path, br#"{"schema_version":4,"enabled":true,"mode":"replace","never_delete_logs":true,"relevance_policy":{"relevant_max":5}}"#, false).unwrap();
        let config = config(root.path()).unwrap().unwrap();
        let stats = b"{\"completed\":7}";
        let snapshot = b"{\"id\":\"previous\"}";
        let events = b"{\"status\":\"keep\"}\n";
        write_private(&root.path().join("stats.json"), stats, false).unwrap();
        write_private(&logs.join("latest-decision.json"), snapshot, false).unwrap();
        write_private(&logs.join("events.jsonl"), events, false).unwrap();
        let session = "staged-publication-regression";
        let session_hash = format!("{:x}", Sha256::digest(session.as_bytes()));
        let id = "d".repeat(32);
        let mut folders = Vec::new();
        for day in [-1, 0, 1] {
            let date = Utc::now() + chrono::Duration::days(day);
            let folder = logs.join(format!(
                "{}-{}",
                date.format("%Y-%m-%d"),
                &session_hash[..10]
            ));
            ensure_dir(&folder).unwrap();
            fs::create_dir(folder.join(format!("batch-{id}-2.json"))).unwrap();
            folders.push(folder);
        }
        let source = "INFO synthetic poll\n".repeat(40) + "ERROR: synthetic failure\nDone\n";
        let mut lines = source_lines(&source);
        protect_neighbors(&mut lines);
        let probabilities = lines.iter().map(|line| (line.number, 0.01)).collect();
        let decisions = apply_relevance(&lines, &probabilities, 5);
        let event = json!({"tool_name":"Bash","session_id":session});
        let result = record(
            root.path(),
            &event,
            "output",
            "replace",
            "relevance_policy",
            &source,
            "filtered",
            &lines,
            &decisions,
            &[batch(1), batch(2)],
            None,
            &config,
            &id,
            &"e".repeat(32),
        );
        assert!(result.is_err());
        assert_eq!(fs::read(root.path().join("stats.json")).unwrap(), stats);
        assert_eq!(
            fs::read(logs.join("latest-decision.json")).unwrap(),
            snapshot
        );
        assert_eq!(fs::read(logs.join("events.jsonl")).unwrap(), events);
        for folder in folders {
            assert!(!folder.join(format!("receipt-{id}.json")).exists());
            assert!(!folder.join(format!("batch-{id}-1.json")).exists());
            assert!(folder.join(format!("batch-{id}-2.json")).is_dir());
        }
        assert!(!fs::read_dir(&logs)
            .unwrap()
            .flatten()
            .any(|entry| entry.file_name().to_string_lossy().starts_with(".jev-")));
    }
}
