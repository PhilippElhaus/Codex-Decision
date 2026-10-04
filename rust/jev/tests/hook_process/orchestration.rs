use super::*;

#[test]
fn code_mode_commands_publish_real_line_decisions_and_preserve_the_envelope() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    fs::create_dir(&data).unwrap();
    fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).unwrap();
    fs::write(
        data.join("config.json"),
        json!({"schema_version":4,"scope":"global",
            "enabled":true,"mode":"replace","allow_mcp_replacement":true,
            "relevance_policy":{"relevant_max":5}})
        .to_string(),
    )
    .unwrap();
    fs::write(data.join(".env"), "JEV_API_KEY=synthetic-test-key\n").unwrap();
    fs::set_permissions(data.join(".env"), fs::Permissions::from_mode(0o600)).unwrap();
    let source = (0..60)
        .map(|i| format!("INFO routine heartbeat {i:04}\n"))
        .collect::<String>()
        + "ERROR: synthetic connection failure\nDone\n";
    let payload = json!({"chunk_id":"synthetic","wall_time_seconds":0.1,
        "exit_code":1,"original_token_count":600,"output":source})
    .to_string();
    let response = json!([
        {"type":"input_text","text":"Script completed\nWall time 0.1 seconds\nOutput:\n"},
        {"type":"input_text","text":payload}
    ]);
    let (endpoint, stop, server) = mock_server(None);
    for (i, tool) in ["exec", "wait", "functions.exec", "functions.wait"]
        .iter()
        .enumerate()
    {
        let session_id = format!("orchestration-{i}");
        let event = json!({"hook_event_name":"PostToolUse","tool_name":tool,
            "session_id":session_id,"tool_use_id":"dummy-call",
            "tool_input":{"input":"text(await tools.exec_command({cmd: 'dummy'}))"},
            "tool_response":response});
        // Code mode carries metadata and several content items. Even explicit
        // MCP replacement permission must not replace its original envelope.
        assert_eq!(send_event(&data, &endpoint, &event), json!({}));
        let session = scoped(&data, &session_id);
        let panel: Value =
            serde_json::from_slice(&fs::read(session.join("logs/latest-decision.json")).unwrap())
                .unwrap();
        assert_eq!(panel["status"], "candidate");
        assert_eq!(panel["totals"]["requests"], 2);
        assert!(panel["totals"]["judged"].as_u64().unwrap() >= 50);
        assert!(panel["rows"]
            .as_array()
            .unwrap()
            .iter()
            .any(|row| row["excerpt"]
                .as_str()
                .unwrap()
                .starts_with("INFO routine heartbeat")));
        let health: Value =
            serde_json::from_slice(&fs::read(session.join("logs/hook-health.json")).unwrap())
                .unwrap();
        assert!(health["last_success_ms"].is_number());
    }
    let event = json!({"hook_event_name":"PostToolUse","tool_name":"exec",
        "session_id":"mixed-media","tool_input":{"input":"image(dummy)"},
        "tool_response":[{"type":"input_text","text":payload},{"type":"input_image"}]});
    assert_eq!(send_event(&data, &endpoint, &event), json!({}));
    assert!(!scoped(&data, "mixed-media")
        .join("logs/latest-decision.json")
        .exists());
    assert!(!data.join("outputs").exists());
    stop.store(true, Ordering::Relaxed);
    assert_eq!(server.join().unwrap(), 8);
}
