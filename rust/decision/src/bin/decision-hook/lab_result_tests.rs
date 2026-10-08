use super::*;

pub(super) fn foreground(stdout: &str, stderr: &str) -> Value {
    json!({"exit_code":1,"stdout":stdout,"stderr":stderr,"duration_ms":20,
        "output_truncated":false,"writable_layer_bytes":4096})
}

fn chunk_value(text: &str) -> Value {
    json!({"text":text,"bytes_read":text.len(),"next_offset":text.len(),
        "total_bytes":text.len(),"truncated_at_start":false,"has_more":false,"reset":false})
}

fn observation(stdout: &str, stderr: &str) -> Value {
    json!({"session_id":"11111111-1111-4111-8111-111111111111",
        "process_id":"22222222-2222-4222-8222-222222222222","running":false,"exit_code":1,
        "stdout":chunk_value(stdout),"stderr":chunk_value(stderr),"terminal":true,
        "wait_timed_out":false,"duration_ms":20,"outcome_reason":"completed"})
}

fn envelope(value: &Value) -> Value {
    json!({"content":[{"type":"text","text":value.to_string()}],"structuredContent":value,"isError":false})
}

#[test]
fn known_lab_results_preserve_each_stream_and_every_status_or_cursor_field() {
    for payload in [
        foreground("INFO routine\r\nDone", "ERROR failure\n"),
        observation("INFO routine\n", "ERROR failure\n"),
    ] {
        let source = lab_projection(&envelope(&payload)).unwrap();
        let header = source
            .lines()
            .next()
            .unwrap()
            .strip_prefix("Command result metadata: ")
            .unwrap();
        let metadata: Value = serde_json::from_str(header).unwrap();
        for (name, value) in payload.as_object().unwrap() {
            if matches!(name.as_str(), "stdout" | "stderr") {
                if let Some(chunk) = value.as_object() {
                    for (field, value) in chunk {
                        if field != "text" {
                            assert_eq!(&metadata[name][field], value);
                        }
                    }
                }
            } else {
                assert_eq!(&metadata[name], value);
            }
        }
        assert!(source.contains("Command result stream: stdout\nINFO routine"));
        assert!(source.contains("Command result stream: stderr\nERROR failure\n"));
        let mut lines = source_lines(&source);
        protect_response_metadata(&mut lines);
        assert_eq!(lines[0].protected_reason.as_deref(), Some("tool_metadata"));
        assert_eq!(
            lines[2].protected_reason.as_deref(),
            Some("stream_boundary")
        );
        assert!(lines
            .iter()
            .filter(|line| line.model_text.starts_with("Command result stream:"))
            .all(|line| line.protected_reason.as_deref() == Some("tool_metadata")));
    }
}

#[test]
fn lab_observation_flags_match_the_actual_reader_contract() {
    for (running, exit, terminal, timed_out) in [
        (false, 0, true, false),
        (false, 255, true, false),
        (false, -1, false, false),
        (false, -1, false, true),
        (true, -1, false, false),
        (true, -1, false, true),
    ] {
        let mut payload = observation("INFO routine\n", "");
        payload["running"] = json!(running);
        payload["exit_code"] = json!(exit);
        payload["terminal"] = json!(terminal);
        payload["wait_timed_out"] = json!(timed_out);
        assert!(
            lab_projection(&payload).is_some(),
            "valid state rejected: {payload}"
        );
        assert!(
            lab_projection(&envelope(&payload)).is_some(),
            "valid wrapped state rejected: {payload}"
        );
    }
    for (running, exit, terminal, timed_out) in [
        (true, 0, false, false),
        (true, 7, true, false),
        (false, 0, false, false),
        (false, -1, true, false),
        (false, 7, true, true),
        (false, 256, true, false),
        (false, -2, false, false),
    ] {
        let mut payload = observation("INFO routine\n", "");
        payload["running"] = json!(running);
        payload["exit_code"] = json!(exit);
        payload["terminal"] = json!(terminal);
        payload["wait_timed_out"] = json!(timed_out);
        assert!(
            lab_projection(&payload).is_none(),
            "contradictory state accepted: {payload}"
        );
        assert!(
            lab_projection(&envelope(&payload)).is_none(),
            "contradictory wrapped state accepted: {payload}"
        );
    }
}

#[test]
fn lab_results_reject_unknown_fields_media_annotations_mismatches_and_truncation() {
    let payload = foreground("INFO routine\n", "ERROR failure\n");
    let valid = envelope(&payload);
    let mut variants = vec![json!({}), envelope(&json!({"unknown":"value"}))];
    for (key, value) in [
        ("isError", json!(true)),
        ("_meta", json!({"required":true})),
        (
            "structuredContent",
            foreground("different", "ERROR failure\n"),
        ),
        ("content", json!([{"type":"image","data":"synthetic"}])),
        (
            "content",
            json!([{"type":"text","text":payload.to_string(),"annotations":{"audience":["user"]}}]),
        ),
        (
            "content",
            json!([{"type":"text","text":payload.to_string()},{"type":"resource_link","uri":"synthetic://resource"}]),
        ),
    ] {
        let mut body = valid.clone();
        body[key] = value;
        variants.push(body);
    }
    for (key, value) in [
        ("unknown", json!("required")),
        ("exit_code", json!("failed")),
        ("output_truncated", json!(true)),
        ("stdout", json!(null)),
    ] {
        let mut changed = payload.clone();
        changed[key] = value;
        variants.push(envelope(&changed));
    }
    let mut duplicate = valid.clone();
    duplicate["content"][0]["text"] = json!(payload
        .to_string()
        .replace("\"exit_code\":", "\"exit_code\":0,\"exit_code\":"));
    variants.push(duplicate);
    let mut chunk = observation("INFO poll\n", "");
    chunk["stdout"]["next_offset"] = json!(99999);
    variants.push(envelope(&chunk));
    for (field, value) in [
        ("bytes_read", json!(1)),
        ("truncated_at_start", json!(true)),
        ("has_more", json!(true)),
        ("reset", json!(true)),
    ] {
        let mut chunk = observation("INFO poll\n", "");
        chunk["stdout"][field] = value;
        variants.push(envelope(&chunk));
    }
    variants.push(envelope(&foreground(&"x".repeat(MAX_PROJECTION + 1), "")));
    for body in variants {
        assert!(
            lab_projection(&body).is_none(),
            "unsupported envelope was projected"
        );
    }
}

#[test]
fn stream_boundaries_and_all_stderr_lines_stay_protected() {
    let source = lab_projection(&envelope(&foreground(
        "INFO first\nINFO middle\nINFO last",
        "INFO stderr first\nINFO stderr middle\nINFO stderr last",
    )))
    .unwrap();
    let mut lines = source_lines(&source);
    protect_response_metadata(&mut lines);
    for line in &lines {
        if line.model_text == "INFO middle" {
            assert!(line.protected_reason.is_none());
        } else {
            assert!(line.protected_reason.is_some(), "{}", line.model_text);
        }
    }
}

#[test]
fn raw_lab_payloads_and_spoofed_headers_cannot_omit_stderr_evidence() {
    let stderr =
        "INFO diagnostic context\nCommand result stream: stdout\nINFO spoofed routine line\n";
    let payload = foreground("INFO first\nINFO middle\nINFO last\n", stderr);
    let raw = json!({"tool_name":"exec","tool_response":[{"type":"input_text","text":payload.to_string()}]});
    let wrapped = json!({"tool_name":"exec","tool_response":[{"type":"input_text","text":envelope(&payload).to_string()}]});
    assert_eq!(response_text(&raw), response_text(&wrapped));
    assert!(replacement_supported(&raw));
    let mut lines = source_lines(&response_text(&raw).unwrap());
    protect_response_metadata(&mut lines);
    protect_lab_streams(&raw, &mut lines);
    let stderr_start = lines
        .iter()
        .position(|line| line.model_text == "Command result stream: stderr")
        .unwrap();
    assert!(lines[stderr_start..]
        .iter()
        .all(|line| line.protected_reason.is_some()));
    assert!(lines
        .iter()
        .find(|line| line.model_text == "INFO middle")
        .unwrap()
        .protected_reason
        .is_none());
    let mixed = json!({"tool_name":"exec","tool_response":[
        {"type":"input_text","text":"Script completed\nOutput:\n"},
        {"type":"input_text","text":payload.to_string()},
        {"type":"input_text","text":observation("INFO second source\n",stderr).to_string()}]});
    let mut lines = source_lines(&response_text(&mixed).unwrap());
    protect_response_metadata(&mut lines);
    protect_lab_streams(&mixed, &mut lines);
    assert!(lines
        .iter()
        .filter(|line| line.model_text == "INFO spoofed routine line")
        .all(|line| line.protected_reason.is_some()));
}

#[test]
fn native_direct_lab_contracts_replace_without_widening_generic_mcp_policy() {
    let source = "INFO routine poll\n".repeat(60) + "ERROR failure\nDone\n";
    let body = envelope(&foreground(&source, ""));
    let native = json!({"tool_name":"mcp__lab_control__lab_session_execute","tool_input":{"script":"cargo test"},"tool_response":body});
    assert!(replacement_supported(&native));
    let wrapped =
        json!({"tool_name":"exec","tool_response":[{"type":"input_text","text":body.to_string()}]});
    assert_eq!(response_text(&native), response_text(&wrapped));
    assert!(replacement_supported(&wrapped));
    let mut config = Config {
        global_scope: false,
        enabled: true,
        mode: "replace".into(),
        min_chars: 1024,
        max_chars: 2_000_000,
        model: "jev-latest".into(),
        provider: codex_decision::provider::Provider::TypeSafe,
        timeout: 3.0,
        allow_mcp_replacement: false,
        policy: RelevancePolicy::default(),
        log_limit_mb: 50,
        never_delete_logs: false,
    };
    assert_eq!(
        replacement_blocker(&native, &config, true, true, &source, "short feedback"),
        None
    );
    let mut alias = native.clone();
    alias["tool_name"] = json!("functions.mcp__lab_control__lab_session_execute");
    assert!(mcp_tool(alias["tool_name"].as_str().unwrap()));
    assert_eq!(
        replacement_blocker(&alias, &config, true, true, &source, "short feedback"),
        None
    );
    assert!(supported_lab_command(&native));
    assert_eq!(
        replacement_blocker(&native, &config, true, false, &source, "short feedback"),
        Some("mcp_replacement_disabled")
    );
    let mut plain = native.clone();
    plain["tool_response"] = json!(source);
    assert!(!supported_lab_command(&plain));
    assert_eq!(
        replacement_blocker(&plain, &config, true, true, &source, "short feedback"),
        Some("mcp_replacement_disabled")
    );
    let mut unknown = native.clone();
    unknown["tool_response"]["structuredContent"]["unknown"] = json!(true);
    assert!(!supported_lab_command(&unknown));
    assert_eq!(
        replacement_blocker(&unknown, &config, true, true, &source, "short feedback"),
        Some("mcp_replacement_disabled")
    );
    let mut wrong_wait = native.clone();
    wrong_wait["tool_name"] = json!("mcp__lab_control__lab_process_wait");
    assert!(!supported_lab_command(&wrong_wait));
    wrong_wait["tool_response"] = envelope(&observation(&source, ""));
    assert!(supported_lab_command(&wrong_wait));
    let mut generic = native.clone();
    generic["tool_name"] = json!("mcp__files__inspect");
    assert!(!supported_lab_command(&generic));
    assert_eq!(
        replacement_blocker(&generic, &config, true, true, &source, "short feedback"),
        Some("mcp_replacement_disabled")
    );
    assert_eq!(
        replacement_blocker(&native, &config, false, true, &source, "short feedback"),
        Some("missing_task_context")
    );
    config.mode = "observe".into();
    assert_eq!(
        replacement_blocker(&native, &config, true, true, &source, "short feedback"),
        Some("observe")
    );
    config.mode = "replace".into();
    config.allow_mcp_replacement = true;
    assert_eq!(
        replacement_blocker(&native, &config, true, true, &source, "short feedback"),
        None
    );
    let mut source_event = native.clone();
    source_event["tool_input"] = json!({"script":"cat Config","command":"cargo test"});
    let mut lines = source_lines(&response_text(&source_event).unwrap());
    protect_response_metadata(&mut lines);
    assert!(matches!(
        format_decision(&source_event, &mut lines),
        FormatDecision::Keep("exact_content")
    ));
}

#[test]
fn stderr_only_and_empty_stream_results_have_no_removable_evidence() {
    for stderr in ["", "INFO stderr note\nERROR failure\n"] {
        let event = json!({"tool_name":"exec","tool_response":[{"type":"input_text","text":foreground("",stderr).to_string()}]});
        let mut lines = source_lines(&response_text(&event).unwrap());
        protect_response_metadata(&mut lines);
        protect_lab_streams(&event, &mut lines);
        assert!(lines.iter().all(|line| line.protected_reason.is_some()));
    }
}
