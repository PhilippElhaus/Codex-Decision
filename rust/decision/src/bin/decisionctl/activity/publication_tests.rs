use super::*;

#[test]
fn cli_uses_prior_committed_stats_until_marker_and_refuses_unknown_mutation() {
    let fixture: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/publication-case.json"
    )))
    .unwrap();
    let root = tempfile::tempdir().unwrap();
    let directory = root.path();
    let logs = directory.join("logs");
    fs::create_dir(&logs).unwrap();
    let write = |path: &Path, bytes: &[u8]| {
        fs::write(path, bytes).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
        }
    };
    let stats = directory.join("stats.json");
    write(&stats, fixture["stats_after"].as_str().unwrap().as_bytes());
    write(
        &logs.join("events.jsonl"),
        format!(
            "{}{}",
            fixture["events_before"].as_str().unwrap(),
            fixture["event"].as_str().unwrap()
        )
        .as_bytes(),
    );
    let journal_path = logs.join(JOURNAL_NAME);
    let mut journal = fixture["prepared"].clone();
    write(&journal_path, &serde_json::to_vec(&journal).unwrap());
    assert_eq!(read_stats(directory).unwrap()["completed"], 1);
    journal["state"] = json!("committed");
    write(&journal_path, &serde_json::to_vec(&journal).unwrap());
    assert_eq!(read_stats(directory).unwrap()["completed"], 2);
    journal["state"] = json!("prepared");
    write(&journal_path, &serde_json::to_vec(&journal).unwrap());
    write(&stats, b"{\"completed\":99}");
    assert!(read_stats(directory)
        .unwrap_err()
        .contains("pending stats changed"));
    assert_eq!(fs::read(&stats).unwrap(), b"{\"completed\":99}");
    write(&stats, fixture["stats_before"].as_str().unwrap().as_bytes());
    write(
        &logs.join("events.jsonl"),
        fixture["events_before"].as_str().unwrap().as_bytes(),
    );
    fs::remove_file(&journal_path).unwrap();
    assert_eq!(read_stats(directory).unwrap()["completed"], 1);
}

#[test]
fn cli_events_only_history_is_partial_and_keeps_known_retained_minima() {
    let root = tempfile::tempdir().unwrap();
    let logs = root.path().join("logs");
    fs::create_dir(&logs).unwrap();
    fs::write(logs.join("events.jsonl"),b"{\"status\":\"keep\",\"reason\":\"kept\",\"requests\":2,\"elapsed_ms\":1000}\n{\"interrupted\":").unwrap();
    let stats = read_stats(root.path()).unwrap();
    let metrics = super::super::snapshot::metrics(&stats, &json!({})).unwrap();
    assert_eq!(metrics["calls"], 2);
    assert_eq!(metrics["completed"], 1);
    assert_eq!(metrics["averageMs"], Value::Null);
    assert_eq!(metrics["seen"], Value::Null);
    assert!(metrics["partialCounters"]
        .as_array()
        .unwrap()
        .iter()
        .any(|name| name == "completed"));
}
