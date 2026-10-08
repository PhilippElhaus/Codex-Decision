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
    let transcript = root.path().join("transcript.jsonl");
    fs::write(
        &transcript,
        json!({"type":"response_item","payload":{"role":"user",
        "content":[{"type":"input_text","text":"Find the connection failure."}]}})
        .to_string()
            + "\n",
    )
    .unwrap();
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
            "session_id":session_id,"tool_use_id":format!("dummy-call-{i}"),"transcript_path":transcript,
            "tool_input":{"input":"text(await tools.exec_command({cmd: 'dummy'}))"},
            "tool_response":response});
        let reply = send_event(&data, &endpoint, &event);
        assert_eq!(reply["continue"], false);
        assert!(reply["reason"]
            .as_str()
            .unwrap()
            .contains("\"exit_code\":1"));
        assert!(reply["reason"]
            .as_str()
            .unwrap()
            .contains("ERROR: synthetic connection failure"));
        let session = scoped(&data, &session_id);
        let panel: Value =
            serde_json::from_slice(&fs::read(session.join("logs/latest-decision.json")).unwrap())
                .unwrap();
        assert_eq!(panel["status"], "replace");
        assert_eq!(panel["totals"]["requests"], 1);
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
    let originals = fs::read_dir(data.join("outputs"))
        .unwrap()
        .flat_map(|entry| fs::read_dir(entry.unwrap().path()).unwrap())
        .filter_map(|entry| {
            let path = entry.unwrap().path();
            (path.extension().is_some_and(|ext| ext == "json")).then_some(path)
        })
        .collect::<Vec<_>>();
    assert_eq!(originals.len(), 4);
    for original in originals {
        assert_eq!(
            serde_json::from_slice::<Value>(&fs::read(original).unwrap()).unwrap(),
            response
        );
    }
    stop.store(true, Ordering::Relaxed);
    assert_eq!(server.join().unwrap(), 4);
}

#[test]
fn shell_scripts_and_mixed_commands_publish_previews_without_replacement() {
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
    let source = "INFO routine heartbeat status unchanged\n".repeat(70)
        + "ERROR: synthetic connection failure\nDone\n";
    let (endpoint, stop, server) = mock_server(None);
    let mut requests = 0;
    for (i, command) in [
        "python3 - <<'PY'\nprint('synthetic log')\nPY",
        "cargo test 2>&1; echo done",
        "rg -n sample src && cat progress.log",
        "cat progress.log | sed -n '1,90p'",
    ]
    .iter()
    .enumerate()
    {
        let session = format!("script-preview-{i}");
        let event = json!({"hook_event_name":"PostToolUse","tool_name":"Bash",
            "session_id":session,"tool_use_id":"dummy-call",
            "tool_input":{"command":command},"tool_response":source});
        assert_eq!(send_event(&data, &endpoint, &event), json!({}));
        let directory = scoped(&data, &session);
        let panel: Value =
            serde_json::from_slice(&fs::read(directory.join("logs/latest-decision.json")).unwrap())
                .unwrap();
        assert_eq!(panel["status"], "candidate");
        let count = panel["totals"]["requests"].as_u64().unwrap();
        assert!(count >= 1);
        assert_eq!(count, panel["batch"]["count"].as_u64().unwrap());
        requests += count;
        assert!(panel["totals"]["omitted"].as_u64().unwrap() > 50);
        assert_eq!(panel["version"], 6);
        assert_eq!(panel["rows"].as_array().unwrap().len(), 72);
        assert_eq!(panel["totals"]["kept"], 3);
        for number in [70, 71, 72] {
            let row = &panel["rows"][number - 1];
            assert_eq!(row["line"], number);
            assert_eq!(row["action"], "keep");
            assert!(row["task_relevant"].is_null());
            assert!(row["protected_reason"].is_string());
        }
        assert!(!data.join("outputs").exists());
    }
    // Sensitive input and structured output keep their existing safeguards.
    for (session, command, source, reason) in [
        (
            "sensitive-script",
            "python3 runner.py --path .env",
            source.as_str(),
            "sensitive",
        ),
        (
            "exact-environment-read",
            "cat .env > output",
            source.as_str(),
            "exact_content",
        ),
        (
            "structured-script",
            "python3 - <<'PY'\nprint('json')\nPY",
            "{\n\"rows\": []\n}\n".repeat(100).as_str(),
            "structure_guard",
        ),
    ] {
        let event = json!({"hook_event_name":"PostToolUse","tool_name":"Bash",
            "session_id":session,"tool_use_id":"dummy-call",
            "tool_input":{"command":command},"tool_response":source});
        assert_eq!(send_event(&data, &endpoint, &event), json!({}));
        let directory = scoped(&data, session);
        let health: Value =
            serde_json::from_slice(&fs::read(directory.join("logs/hook-health.json")).unwrap())
                .unwrap();
        assert_eq!(health["last_skip"], reason);
        assert!(!directory.join("logs/latest-decision.json").exists());
    }
    stop.store(true, Ordering::Relaxed);
    assert_eq!(server.join().unwrap() as u64, requests);
}
