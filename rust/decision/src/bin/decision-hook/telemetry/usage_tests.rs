use super::*;

fn selected(root: &Path) -> Config {
    ensure_dir(root).unwrap();
    write_private(&root.join("config.json"),
        br#"{"schema_version":5,"enabled":true,"mode":"observe","provider":"openai","model":"gpt-6-luna","min_chars":256,"relevance_policy":{"relevant_max":5}}"#,
        false).unwrap();
    config(root).unwrap().unwrap()
}

fn rows(root: &Path) -> Vec<Value> {
    fs::read_to_string(root.join("logs/telemetry.jsonl"))
        .unwrap()
        .lines()
        .map(|row| serde_json::from_str(row).unwrap())
        .collect()
}

#[test]
fn local_skips_record_sizes_and_reason_without_payloads_or_tool_identity() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("data");
    ensure_dir(&root).unwrap();
    let config = selected(root.as_path());
    let event = json!({"hook_event_name":"PostToolUse","session_id":"private-session",
        "tool_use_id":"private-call","tool_name":"Bash",
        "tool_input":{"command":"echo private-command-sentinel"},
        "tool_response":"private-response-sentinel"});
    assert_eq!(
        process_event(root.as_path(), root.as_path(), &event, &config).unwrap(),
        json!({})
    );
    let records = rows(root.as_path());
    assert_eq!(records.len(), 2);
    assert_eq!(records[0]["event"], "invocation_start");
    assert_eq!(records[1]["event"], "invocation");
    assert_eq!(records[1]["outcome"], "skip");
    assert_eq!(records[1]["reason"], "small");
    assert_eq!(records[1]["source_bytes"], 25);
    assert_eq!(records[1]["source_lines"], 1);
    assert_eq!(records[1]["request_count"], 0);
    assert_eq!(records[0]["invocation_id"], records[1]["invocation_id"]);
    let serialized = serde_json::to_string(&records).unwrap();
    for sentinel in [
        "private-session",
        "private-call",
        "private-command-sentinel",
        "private-response-sentinel",
        "Bash",
    ] {
        assert!(!serialized.contains(sentinel), "leaked {sentinel}");
    }
}

#[test]
fn unknown_error_details_are_replaced_with_fixed_codes() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("data");
    ensure_dir(&root).unwrap();
    let config = selected(root.as_path());
    start(
        root.as_path(),
        &json!({"tool_name":"mcp__secret_tool_name"}),
        &config,
    );
    finish(&Err("private-provider-url-and-error-body".into()));
    let records = rows(root.as_path());
    assert_eq!(records[1]["reason"], "local_or_validation_error");
    assert_eq!(records[1]["outcome"], "error");
    assert_eq!(records[1]["tool_family"], "other_mcp");
    assert!(!serde_json::to_string(&records)
        .unwrap()
        .contains("private-provider"));
}

#[test]
fn relevance_metrics_separate_threshold_guard_restoration_and_prepared_omissions() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("data");
    ensure_dir(&root).unwrap();
    let config = selected(root.as_path());
    let mut lines = source_lines("duplicate\nduplicate\nrelevant\nprotected\npending\nlast\n");
    for line in &mut lines {
        line.eligible = true;
        line.protected_reason = None;
    }
    lines[3].protected_reason = Some("diagnostic".into());
    let probabilities = BTreeMap::from([(1, 0.05), (2, 0.01), (3, 0.06), (4, 0.01), (6, 0.01)]);
    let decisions = apply_relevance(&lines, &probabilities, 5);
    for replacement in [false, true] {
        start(root.as_path(), &json!({"tool_name":"Bash"}), &config);
        completed(
            if replacement { "replace" } else { "candidate" },
            "observe",
            5,
            1,
            0,
        );
        line_outcomes(&lines, &decisions, 5, replacement);
        finish(&Ok(json!({})));
        let records = rows(root.as_path());
        let completion = records.last().unwrap();
        assert_eq!(completion["lines_relevance_below_cutoff"], 3);
        assert_eq!(completion["lines_restored_by_guards"], 2);
        assert_eq!(completion["proposed_omitted"], 1);
        assert_eq!(completion["prepared_omitted_lines"], u64::from(replacement));
    }
}

#[test]
fn telemetry_retention_repairs_partial_rows_and_preserves_no_delete_content_at_capacity() {
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("data");
    ensure_dir(&root).unwrap();
    ensure_dir(&root.as_path().join("logs")).unwrap();
    let path = root.as_path().join("logs/telemetry.jsonl");
    write_private(&path, b"{\"complete\":true}\n{\"partial\":", false).unwrap();
    log::append(root.as_path(), &json!({"new":true}), false).unwrap();
    let records = rows(root.as_path());
    assert_eq!(records, vec![json!({"complete":true}), json!({"new":true})]);
    let large = b"{\"padding\":true}\n".repeat(log::LIMIT / 17 + 1);
    write_private(&path, &large, true).unwrap();
    let before = fs::read(&path).unwrap();
    assert!(log::append(root.as_path(), &json!({"new":true}), true).is_err());
    assert_eq!(fs::read(&path).unwrap(), before);
    log::append(root.as_path(), &json!({"new":true}), false).unwrap();
    assert!(fs::metadata(&path).unwrap().len() <= log::LIMIT as u64);
    assert_eq!(rows(root.as_path()).last().unwrap(), &json!({"new":true}));
}

#[cfg(unix)]
#[test]
fn unsafe_telemetry_targets_do_not_change_filter_results_or_block() {
    use std::os::unix::fs::symlink;
    let fixture = tempfile::tempdir().unwrap();
    let root = fixture.path().join("data");
    ensure_dir(&root).unwrap();
    let config = selected(root.as_path());
    let logs = root.as_path().join("logs");
    ensure_dir(&logs).unwrap();
    let original = root.as_path().join("protected.txt");
    write_private(&original, b"private-original", false).unwrap();
    symlink(&original, logs.join("telemetry.jsonl")).unwrap();
    let result = process_event(
        root.as_path(),
        root.as_path(),
        &json!({"hook_event_name":"PostToolUse",
        "tool_name":"Bash","tool_response":"short"}),
        &config,
    )
    .unwrap();
    assert_eq!(result, json!({}));
    assert_eq!(fs::read(&original).unwrap(), b"private-original");
    fs::remove_file(logs.join("telemetry.jsonl")).unwrap();
    let held = try_telemetry_lock(&logs).unwrap();
    let started = Instant::now();
    assert!(log::append(root.as_path(), &json!({"new":true}), false).is_err());
    assert!(started.elapsed() < Duration::from_millis(100));
    drop(held);
    assert!(!logs.join("telemetry.jsonl").exists());
}
