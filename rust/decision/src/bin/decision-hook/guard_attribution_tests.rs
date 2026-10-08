use super::*;

fn config() -> Config {
    Config {
        global_scope: false,
        enabled: true,
        mode: "replace".into(),
        min_chars: 256,
        max_chars: 2_000_000,
        model: "gpt-6-luna".into(),
        provider: codex_decision::provider::Provider::OpenAi,
        timeout: 1.0,
        allow_mcp_replacement: false,
        policy: RelevancePolicy::default(),
        log_limit_mb: 50,
        never_delete_logs: false,
    }
}

fn run(command: &str, source: &str, extra: Value) -> Value {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    let scoped = data.join("session");
    ensure_dir(&data).unwrap();
    ensure_dir(&scoped).unwrap();
    let transcript = root.path().join("malformed.jsonl");
    fs::write(&transcript, "not a transcript\n").unwrap();
    let mut input = json!({"command":command});
    input
        .as_object_mut()
        .unwrap()
        .extend(extra.as_object().unwrap().clone());
    let event = json!({"hook_event_name":"PostToolUse", "session_id":"guard-test", "tool_name":"Bash",
        "tool_input":input, "tool_response":source, "transcript_path":transcript});
    assert_eq!(
        process_event(&data, &scoped, &event, &config()).unwrap(),
        json!({})
    );
    let health: Value =
        serde_json::from_slice(&fs::read(scoped.join("logs/hook-health.json")).unwrap()).unwrap();
    assert!(
        health.get("api_requests").is_none(),
        "Local guards must never need a provider"
    );
    health
}

#[test]
fn exact_reads_keep_their_reason_without_reading_an_unusable_task() {
    let source = "const access_token = process.env.ACCESS_TOKEN;\n".repeat(20);
    let health = run("cat settings.rs", &source, json!({}));
    assert_eq!(health["last_skip"], "exact_content");
    assert!(health.get("skip_details").is_none());
}

#[test]
fn coupled_build_output_stays_local_before_task_context() {
    let source = "collecting synthetic pytest items without final totals\n".repeat(30);
    let health = run("pytest", &source, json!({}));
    assert!(matches!(
        health["last_skip"].as_str(),
        Some("structure_guard" | "no_eligible_lines")
    ));
}

#[test]
fn privacy_details_separate_output_command_and_other_input() {
    let source = "INFO routine heartbeat\n".repeat(30) + "ERROR: synthetic failure\nDone\n";
    let cases = [
        (
            "synthetic-worker",
            source.clone() + "password=synthetic-sentinel\n",
            json!({}),
            "protected_output",
        ),
        (
            "synthetic-worker --secret=synthetic-sentinel",
            source.clone(),
            json!({}),
            "protected_command",
        ),
        (
            "synthetic-worker",
            source,
            json!({"authorization":"synthetic-sentinel"}),
            "protected_input",
        ),
    ];
    for (command, source, input, detail) in cases {
        let health = run(command, &source, input);
        assert_eq!(health["last_skip"], "sensitive");
        assert_eq!(health["last_skip_detail"], detail);
        assert_eq!(health["skip_details"][detail], 1);
        assert!(!serde_json::to_string(&health)
            .unwrap()
            .contains("synthetic-sentinel"));
    }
}
