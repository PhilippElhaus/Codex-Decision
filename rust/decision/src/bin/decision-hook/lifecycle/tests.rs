use super::*;

fn private_fixture() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root.path(), fs::Permissions::from_mode(0o700)).unwrap();
    }
    #[cfg(windows)]
    codex_decision::windows::secure(root.path(), true).unwrap();
    root
}

#[test]
fn model_hooks_emit_only_counts_and_leave_filter_health_untouched() {
    let root = private_fixture();
    ensure_dir(root.path()).unwrap();
    let config = assistance_runtime::selected_config(root.path(), None).unwrap();
    let event = json!({"hook_event_name":"PostModelRequest","turn_id":"synthetic-turn","status":"completed",
        "model":"private-model-name","error":"private-error-text","token_usage":{"input_tokens":120,"cached_input_tokens":100,"output_tokens":5}});
    assert_eq!(
        process(root.path(), root.path(), &event, &config).unwrap(),
        json!({})
    );
    assert!(!root.path().join("logs/hook-health.json").exists());
    let bytes = fs::read(root.path().join("logs/model-requests.jsonl")).unwrap();
    let text = String::from_utf8(bytes).unwrap();
    for secret in ["private-model-name", "private-error-text", "synthetic-turn"] {
        assert!(!text.contains(secret));
    }
    let row: Value = serde_json::from_str(text.trim()).unwrap();
    assert_eq!(row["usage"]["cached_tokens"], 100);
    assert_eq!(row["delivery"], "unverified");
}

#[test]
fn evidence_is_bound_to_a_turn_and_continuation_marker_survives_repeated_callbacks() {
    let root = private_fixture();
    ensure_dir(root.path()).unwrap();
    let event = json!({"turn_id":"turn-one","tool_name":"Bash","tool_input":{"command":"cargo test"},"tool_response":"test failed: expected 2, got 1"});
    evidence::capture(root.path(), &event).unwrap();
    let key = turn_key(&event).unwrap();
    let snapshot = evidence::load(root.path(), &key).unwrap().unwrap();
    assert!(evidence::load(root.path(), "another-turn")
        .unwrap()
        .is_none());
    assert!(evidence::mark_continued(root.path(), &key, &snapshot).unwrap());
    assert!(!evidence::mark_continued(root.path(), &key, &snapshot).unwrap());
}

#[test]
fn skipped_later_observations_invalidate_enforcement_of_older_failures() {
    let root = private_fixture();
    ensure_dir(root.path()).unwrap();
    let mut event = json!({"turn_id":"turn-one","tool_name":"Bash","tool_input":{"command":"cargo test"},"tool_response":"test failed"});
    evidence::capture(root.path(), &event).unwrap();
    event["tool_response"] = json!("a".repeat(12_001));
    evidence::capture(root.path(), &event).unwrap();
    let turn = turn_key(&event).unwrap();
    let snapshot = evidence::load(root.path(), &turn).unwrap().unwrap();
    assert_eq!(snapshot["incomplete"], true);
    assert!(!evidence::mark_continued(root.path(), &turn, &snapshot).unwrap());
}

#[test]
fn secret_or_oversized_evidence_is_never_retained_and_no_evidence_never_contacts_a_provider() {
    let root = private_fixture();
    ensure_dir(root.path()).unwrap();
    for source in [
        "password=synthetic-secret-value".to_owned(),
        "x".repeat(12_001),
    ] {
        let event = json!({"turn_id":"t","tool_name":"Bash","tool_input":{"command":"cargo test"},"tool_response":source});
        evidence::capture(root.path(), &event).unwrap();
        let captured =
            fs::read_to_string(root.path().join("logs/completion-evidence.json")).unwrap();
        assert!(!captured.contains("synthetic-secret-value"));
        let snapshot: Value = serde_json::from_str(&captured).unwrap();
        assert_eq!(snapshot["incomplete"], true);
        assert_eq!(snapshot["evidence"], json!([]));
    }
    let config = assistance_runtime::selected_config(root.path(), None).unwrap();
    fs::write(
        root.path().join("assistance.json"),
        r#"{"version":1,"completion_verification":"enforce"}"#,
    )
    .unwrap();
    let event = json!({"hook_event_name":"Stop","turn_id":"t","stop_hook_active":false,"last_assistant_message":"All tests passed"});
    assert_eq!(
        process(root.path(), root.path(), &event, &config).unwrap(),
        json!({})
    );
    assert!(!root.path().join("assistance").exists());
}
