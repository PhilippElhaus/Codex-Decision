use super::*;

fn user_record(task: &str) -> Vec<u8> {
    let mut row = serde_json::to_vec(&json!({"type":"response_item","payload":{
        "role":"user","content":[{"type":"input_text","text":task}]}}))
    .unwrap();
    row.push(b'\n');
    row
}

#[test]
fn invalid_utf8_latest_tasks_are_not_replaced_with_lossy_text() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("transcript.jsonl");
    let mut latest = user_record("Inspect the markerZ result");
    let index = latest
        .windows(7)
        .position(|part| part == b"markerZ")
        .unwrap();
    latest[index + 6] = 0xff;
    let suffix = serde_json::to_vec(&json!({"type":"response_item","payload":{
        "role":"assistant","content":"x".repeat(70_000)}}))
    .unwrap();
    for fallback in [false, true] {
        let mut rows = user_record("Inspect an older result");
        rows.extend_from_slice(&latest);
        if fallback {
            rows.extend_from_slice(&suffix);
            rows.push(b'\n');
        }
        fs::write(&path, &rows).unwrap();
        assert!(
            task_context(&json!({"transcript_path":path})).is_err(),
            "invalid latest user text was accepted; fallback={fallback}"
        );
        rows.extend_from_slice(&user_record("Inspect the valid newer result 🌍"));
        fs::write(&path, &rows).unwrap();
        assert_eq!(
            task_context(&json!({"transcript_path":path})).unwrap(),
            Some("Inspect the valid newer result 🌍".into())
        );
    }
}

#[test]
fn a_tail_window_inside_a_multibyte_record_does_not_corrupt_complete_user_text() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("transcript.jsonl");
    let mut rows = serde_json::to_vec(&json!({"type":"response_item","payload":{
        "role":"assistant","content":"🌍".repeat(25_000)}}))
    .unwrap();
    rows.push(b'\n');
    rows.extend_from_slice(&user_record("Inspect the valid latest result Ω"));
    fs::write(&path, rows).unwrap();
    assert_eq!(
        task_context(&json!({"transcript_path":path})).unwrap(),
        Some("Inspect the valid latest result Ω".into())
    );
}

#[test]
fn a_genuine_replacement_character_in_a_valid_task_remains_valid() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("transcript.jsonl");
    fs::write(&path, user_record("Find the literal � output marker")).unwrap();
    assert_eq!(
        task_context(&json!({"transcript_path":path})).unwrap(),
        Some("Find the literal � output marker".into())
    );
}
