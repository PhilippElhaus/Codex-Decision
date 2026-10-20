use super::*;

fn fixture() -> Value {
    json!({"tool_name":"exec_command","tool_use_id":"synthetic-call",
        "tool_input":{"cmd":"printf synthetic","large_integer":u64::MAX},
        "tool_response":{"stdout":"synthetic output\n","exit_code":0}})
}

fn enable(data: &Path, value: bool) {
    ensure_dir(data).unwrap();
    let logs = data.join("logs");
    ensure_dir(&logs).unwrap();
    write_private(
        &logs.join("skipped-raw-enabled.json"),
        format!("{{\"version\":1,\"enabled\":{value}}}").as_bytes(),
        true,
    )
    .unwrap();
}

#[test]
fn skipped_payloads_stay_local_and_only_capture_after_opt_in() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("session");
    ensure_dir(&data).unwrap();
    let event = fixture();
    assert_eq!(skip_event(&data, &event, "small").unwrap(), json!({}));
    let raw = data.join("logs/skipped-raw.json");
    assert!(!raw.exists());
    enable(&data, true);
    assert_eq!(skip_event(&data, &event, "small").unwrap(), json!({}));
    let store: Store = serde_json::from_slice(&fs::read(&raw).unwrap()).unwrap();
    assert_eq!(store.entries.len(), 1);
    let payload = store.entries[0].payload.as_ref().unwrap();
    assert!(payload.tool_input_json.contains("18446744073709551615"));
    assert_eq!(
        serde_json::from_str::<Value>(&payload.tool_input_json).unwrap(),
        event["tool_input"]
    );
    assert_eq!(
        serde_json::from_str::<Value>(&payload.tool_response_json).unwrap(),
        event["tool_response"]
    );
    let before = fs::read(&raw).unwrap();
    enable(&data, false);
    skip_event(&data, &event, "small").unwrap();
    assert_eq!(fs::read(&raw).unwrap(), before);
    assert_eq!(load_stats(&data.join("stats.json")).unwrap()["calls"], 0);
    let health: Value =
        serde_json::from_slice(&fs::read(data.join("logs/hook-health.json")).unwrap()).unwrap();
    assert_eq!(health["skipped"], 3);
}

#[test]
fn recent_capture_has_count_size_and_payload_limits_without_changing_skips() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("session");
    enable(&data, true);
    for _ in 0..25 {
        capture(&data, &fixture(), "small", None).unwrap();
    }
    let path = data.join("logs/skipped-raw.json");
    let store: Store = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(store.entries.len(), MAX_ENTRIES);
    let mut large = fixture();
    large["tool_response"] = json!("x".repeat(MAX_PAYLOAD_BYTES));
    capture(&data, &large, "large", None).unwrap();
    let store: Store = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    let last = store.entries.last().unwrap();
    assert!(last.payload.is_none());
    assert_eq!(last.payload_unavailable.as_deref(), Some("size_limit"));
    large["tool_response"] = json!("x".repeat(400_000));
    for _ in 0..15 {
        capture(&data, &large, "large", None).unwrap();
    }
    assert!(fs::metadata(&path).unwrap().len() <= MAX_STORE_BYTES as u64);
    let store: Store = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert!(store.entries.len() < MAX_ENTRIES);
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    assert_eq!(
        skip_event_with_detail(&data, &fixture(), "sensitive", "protected_input").unwrap(),
        json!({}),
        "optional capture errors must not change a skip or its accounting"
    );
}

#[cfg(unix)]
#[test]
fn skipped_capture_rejects_links_and_public_preferences() {
    use std::os::unix::fs::{symlink, PermissionsExt};
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("session");
    enable(&data, true);
    let flag = data.join("logs/skipped-raw-enabled.json");
    fs::set_permissions(&flag, fs::Permissions::from_mode(0o644)).unwrap();
    assert!(capture(&data, &fixture(), "small", None).is_err());
    fs::set_permissions(&flag, fs::Permissions::from_mode(0o600)).unwrap();
    let target = root.path().join("outside.json");
    fs::write(&target, b"synthetic sentinel").unwrap();
    symlink(&target, data.join("logs/skipped-raw.json")).unwrap();
    assert!(capture(&data, &fixture(), "small", None).is_err());
    assert_eq!(fs::read(&target).unwrap(), b"synthetic sentinel");
}
