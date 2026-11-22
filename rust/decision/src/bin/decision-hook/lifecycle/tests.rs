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
fn failed_capture_writes_fence_stale_evidence_and_keep_later_captures_incomplete() {
    for failed_file in [".completion-generation", "completion-evidence.json"] {
        let root = private_fixture();
        let mut event = json!({"turn_id":"turn-one","tool_name":"Bash","tool_input":{"command":"cargo test"},"tool_response":"test failed"});
        assert_eq!(evidence::capture(root.path(), &event).unwrap(), "stored");
        let turn = turn_key(&event).unwrap();
        let original = evidence::load(root.path(), &turn).unwrap().unwrap();
        event["tool_response"] = json!("tests passed");
        assert!(evidence::capture_with(root.path(), &event, |path, bytes| {
            if path.file_name().unwrap() == failed_file {
                return Err("synthetic write failure".into());
            }
            write_private(path, bytes, true)
        })
        .is_err());
        let retained = evidence::load(root.path(), &turn).unwrap().unwrap();
        assert_eq!(retained["evidence"], original["evidence"]);
        assert_eq!(retained["incomplete"], true);
        assert!(!evidence::mark_continued(root.path(), &turn, &original).unwrap());
        assert!(!evidence::mark_continued(root.path(), &turn, &retained).unwrap());
        assert_eq!(
            evidence::capture(root.path(), &event).unwrap(),
            "incomplete"
        );
        assert_eq!(
            evidence::load(root.path(), &turn).unwrap().unwrap()["incomplete"],
            true
        );
    }
}

#[test]
fn a_failed_first_capture_cannot_be_hidden_by_a_later_capture() {
    for failed_file in [".completion-generation", "completion-evidence.json"] {
        let root = private_fixture();
        let event = json!({"turn_id":"turn-one","tool_name":"Bash","tool_input":{"command":"cargo test"},"tool_response":"tests passed"});
        assert!(evidence::capture_with(root.path(), &event, |path, bytes| {
            if path.file_name().unwrap() == failed_file {
                return Err("synthetic capture write failure".into());
            }
            write_private(path, bytes, true)
        })
        .is_err());
        assert_eq!(
            evidence::capture(root.path(), &event).unwrap(),
            "incomplete"
        );
        let turn = turn_key(&event).unwrap();
        let snapshot = evidence::load(root.path(), &turn).unwrap().unwrap();
        assert!(!evidence::mark_continued(root.path(), &turn, &snapshot).unwrap());
    }
}

#[test]
fn old_evidence_without_a_generation_is_advisory_only() {
    let root = private_fixture();
    let event = json!({"turn_id":"older-turn"});
    let turn = turn_key(&event).unwrap();
    ensure_dir(&root.path().join("logs")).unwrap();
    let old =
        json!({"version":1,"turn_key":turn,"continued":false,"incomplete":false,"evidence":[]});
    write_private(
        &root.path().join("logs/completion-evidence.json"),
        &serde_json::to_vec(&old).unwrap(),
        false,
    )
    .unwrap();
    let snapshot = evidence::load(root.path(), &turn).unwrap().unwrap();
    assert_eq!(snapshot["incomplete"], true);
    assert!(!evidence::mark_continued(root.path(), &turn, &old).unwrap());
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
    let text = fs::read_to_string(root.path().join("logs/model-requests.jsonl")).unwrap();
    let row: Value = serde_json::from_str(text.trim()).unwrap();
    assert_eq!(row["outcome"], "missing_evidence");
    assert_eq!(row["evidence_coverage"], "incomplete");
    assert_eq!(row["continued"], false);
    assert!(!text.contains("All tests passed"));
}
