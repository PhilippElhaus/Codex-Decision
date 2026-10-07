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
