use super::*;

#[test]
fn request_attempts_survive_failure_without_publishing_completion_stats() {
    let root = tempfile::tempdir().unwrap();
    fs::write(root.path().join("stats.json"), r#"{"calls":7}"#).unwrap();
    hook_health(root.path(), "request", "").unwrap();
    hook_health(root.path(), "error", "Decision request failed").unwrap();
    hook_health(root.path(), "request", "").unwrap();
    let health: Value =
        serde_json::from_slice(&fs::read(root.path().join("logs/hook-health.json")).unwrap())
            .unwrap();
    assert_eq!(health["api_requests"], 9);
    assert_eq!(
        load_stats(&root.path().join("stats.json")).unwrap()["calls"],
        7
    );
    assert!(!root.path().join("logs/latest-decision.json").exists());
}

#[test]
fn delimited_credential_fields_are_sensitive_before_any_request() {
    for text in [
        "password: synthetic-sentinel",
        "PASSWORD   = synthetic-sentinel",
        r#"{"password":"synthetic-sentinel"}"#,
        r#"{"api_key" : "synthetic-sentinel"}"#,
        r#"{"token":"synthetic-sentinel"}"#,
        "<password>synthetic-sentinel</password>",
        "Authorization : Basic synthetic-sentinel",
    ] {
        assert!(sensitive(text), "{text}");
    }
    for text in [
        "INFO token_count=350",
        "INFO password_checks=12",
        "INFO maximum retries = 5",
    ] {
        assert!(!sensitive(text));
    }
}

#[test]
fn duplicate_settings_cannot_override_an_explicit_off_flag_or_cutoff() {
    let root = tempfile::tempdir().unwrap();
    fs::write(
        root.path().join("config.json"),
        r#"{"schema_version":4,"enabled":false,"enabled":true,"mode":"replace","relevance_policy":{"relevant_max":5}}"#,
    )
    .unwrap();
    assert!(config(root.path()).is_err());
    fs::write(
        root.path().join("config.json"),
        r#"{"schema_version":4,"enabled":true,"mode":"replace","relevance_policy":{"relevant_max":5}}"#,
    )
    .unwrap();
    let mut selected = config(root.path()).unwrap().unwrap();
    fs::write(root.path().join("settings.json"),
        r#"{"schema_version":3,"mode":"replace","relevance_policy":{"relevant_max":0,"relevant_max":50},"log_limit_mb":50,"never_delete_logs":false}"#).unwrap();
    assert!(apply_shared_settings(root.path(), &mut selected).is_err());
}

#[test]
fn old_or_unknown_config_never_looks_disabled() {
    let directory = tempfile::tempdir().unwrap();
    for value in [
        json!({"enabled":true}),
        json!({"schema_version":1,"enabled":true}),
        json!({"schema_version":6,"enabled":true}),
    ] {
        fs::write(directory.path().join("config.json"), value.to_string()).unwrap();
        assert!(config(directory.path())
            .err()
            .unwrap()
            .contains("unsupported config version"));
    }
}

#[test]
fn malformed_optional_settings_do_not_fall_back_to_defaults() {
    let directory = tempfile::tempdir().unwrap();
    let baseline = json!({"schema_version":2,"enabled":true,"test_build_enabled":false,
        "search_listing_enabled":false,"mode":"replace",
        "line_policy":{"output":{},"test_build":{},"search_listing":{}}});
    for (key, bad) in [
        ("min_chars", json!("256")),
        ("max_chars", json!(-1)),
        ("timeout_seconds", json!("three")),
        ("model", json!("jev-")),
        ("allow_mcp_replacement", json!("yes")),
        ("never_delete_logs", json!(1)),
        ("log_limit_mb", json!(0)),
        ("unknown", json!(true)),
    ] {
        let mut entered = baseline.clone();
        entered[key] = bad;
        fs::write(directory.path().join("config.json"), entered.to_string()).unwrap();
        assert!(config(directory.path()).is_err(), "{key}");
    }
    fs::write(directory.path().join("config.json"), baseline.to_string()).unwrap();
    assert!(config(directory.path()).unwrap().is_some());
}

#[test]
fn shared_settings_override_session_behavior_without_changing_route_selection() {
    let directory = tempfile::tempdir().unwrap();
    let baseline = json!({"schema_version":2,"enabled":true,"test_build_enabled":false,
        "search_listing_enabled":true,"mode":"replace",
        "line_policy":{"output":{},"test_build":{},"search_listing":{}}});
    fs::write(directory.path().join("config.json"), baseline.to_string()).unwrap();
    let mut selected = config(directory.path()).unwrap().unwrap();
    let settings = json!({"schema_version":1,"mode":"observe","choice_gate_enabled":false,
        "line_policy":{"output":{"omit_min":80,"exact_max":10},
            "test_build":{"omit_min":85,"exact_max":5},
            "search_listing":{"omit_min":90,"exact_max":4}},
        "search_relevance":{"guard_enabled":true,"relevant_max":15},
        "log_limit_mb":75,"never_delete_logs":true});
    fs::write(directory.path().join("settings.json"), settings.to_string()).unwrap();
    apply_shared_settings(directory.path(), &mut selected).unwrap();
    assert!(selected.enabled);
    assert_eq!(selected.mode, "observe");
    assert_eq!(selected.policy.relevant_max, 4);
    assert!(selected.never_delete_logs);
    let mut malformed = settings.clone();
    malformed["line_policy"]["output"]["omit_min"] = json!(101);
    fs::write(
        directory.path().join("settings.json"),
        malformed.to_string(),
    )
    .unwrap();
    assert!(apply_shared_settings(directory.path(), &mut selected).is_err());
}

#[test]
fn hook_status_records_skips_and_errors_without_tool_text() {
    let directory = tempfile::tempdir().unwrap();
    let data = directory.path().join("data");
    hook_health(&data, "seen", "").unwrap();
    skip(&data, "small").unwrap();
    hook_health(&data, "error", "invalid Decision response").unwrap();
    let bytes = fs::read(data.join("logs/hook-health.json")).unwrap();
    let status: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status["last_skip"], "small");
    assert_eq!(status["skipped"], 1);
    assert_eq!(status["last_error"], "invalid Decision response");
    assert!(!String::from_utf8_lossy(&bytes).contains("tool_response"));
    hook_health(&data, "success", "").unwrap();
    let updated: Value =
        serde_json::from_slice(&fs::read(data.join("logs/hook-health.json")).unwrap()).unwrap();
    assert!(updated["last_success_ms"].as_i64() >= status["last_error_ms"].as_i64());
}

fn enabled() -> Config {
    Config {
        global_scope: false,
        enabled: true,
        mode: "observe".into(),
        min_chars: 1024,
        max_chars: 2_000_000,
        model: "jev-latest".into(),
        provider: codex_decision::provider::Provider::TypeSafe,
        timeout: 3.0,
        allow_mcp_replacement: false,
        policy: RelevancePolicy::default(),
        log_limit_mb: 50,
        never_delete_logs: false,
    }
}

#[test]
fn failed_record_never_publishes_a_replace_event_or_receipt() {
    for failure in ["stats", "snapshot", "artifact"] {
        let root = tempfile::tempdir().unwrap();
        let data = root.path().join("data");
        ensure_dir(&data).unwrap();
        let logs = data.join("logs");
        ensure_dir(&logs).unwrap();
        let event = json!({"session_id":"transaction","tool_name":"Bash","tool_input":{"command":"echo progress"}});
        let source = "routine progress\nsummary\n";
        let lines = source_lines(source);
        let batch = relevance_requests(
            "Check progress",
            "echo progress",
            "repetitive_log",
            &lines,
            "jev-latest",
        )
        .unwrap()
        .remove(0);
        let probabilities = lines
            .iter()
            .map(|line| (line.number, (0.99, 0.01, None, 1)))
            .collect();
        let decisions = apply_probabilities(
            &lines,
            &probabilities,
            &LinePolicy::default(),
            &SearchRelevancePolicy::default(),
        );
        let records = vec![BatchRecord {
            id: 1,
            target_numbers: batch.target_numbers,
            request: batch.request,
            response: json!({}),
            elapsed_ms: 1,
        }];
        let mut config = enabled();
        config.mode = "replace".into();
        config.policy = RelevancePolicy::default();
        if failure == "stats" {
            fs::write(data.join("stats.json"), "{\"calls\":\"invalid\"}").unwrap();
        }
        if failure == "snapshot" {
            fs::create_dir(logs.join("latest-decision.json")).unwrap();
        }
        if failure == "artifact" {
            let hash = format!("{:x}", Sha256::digest(b"transaction"));
            let folder = logs.join(format!("{}-{}", Utc::now().format("%Y-%m-%d"), &hash[..10]));
            ensure_dir(&folder).unwrap();
            fs::write(
                folder.join("batch-receipt-1.json"),
                "user-owned existing file",
            )
            .unwrap();
        }
        assert!(record(
            &data,
            &event,
            "output",
            "replace",
            "relevance_policy",
            source,
            "summary\n",
            &lines,
            &decisions,
            &records,
            None,
            &config,
            "receipt",
            "snapshot"
        )
        .is_err());
        assert!(
            !logs.join("events.jsonl").exists()
                || fs::read(logs.join("events.jsonl")).unwrap().is_empty()
        );
        assert!(
            !data.join("stats.json").exists()
                || fs::read_to_string(data.join("stats.json")).unwrap()
                    == "{\"calls\":\"invalid\"}"
        );
        for entry in fs::read_dir(&logs)
            .unwrap()
            .flatten()
            .filter(|entry| entry.path().is_dir())
        {
            assert!(!entry.path().join("receipt-receipt.json").exists());
        }
    }
}

#[test]
fn ancestor_links_and_contended_log_locks_fail_within_a_bound() {
    let root = tempfile::tempdir().unwrap();
    let data = root.path().join("data");
    ensure_dir(&data).unwrap();
    #[cfg(unix)]
    {
        let linked = root.path().join("linked");
        std::os::unix::fs::symlink(&data, &linked).unwrap();
        assert!(ensure_dir(&linked.join("child")).is_err());
        assert!(!data.join("child").exists());
        let first = lock_logs(&data).unwrap();
        let started = Instant::now();
        assert!(lock_logs(&data).is_err());
        assert!(started.elapsed() < Duration::from_secs(3));
        drop(first);
    }
}

#[test]
fn corrupt_stats_are_reported_instead_of_reset() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("stats.json");
    assert_eq!(load_stats(&path).unwrap(), json!({}));
    for invalid in ["{broken", "[]", "{\"calls\":-1}", "{\"calls\":\"one\"}"] {
        fs::write(&path, invalid).unwrap();
        assert!(load_stats(&path).is_err());
    }
    fs::write(&path, "{\"calls\":4}").unwrap();
    assert_eq!(load_stats(&path).unwrap()["calls"], 4);
}

#[test]
fn private_reads_enforce_the_bound_and_do_not_wait_on_special_files() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.json");
    assert!(private_backup(&path, 4).unwrap().is_none());
    fs::write(&path, b"1234").unwrap();
    assert_eq!(read_bounded(&path, 4).unwrap(), b"1234");
    assert!(read_bounded(&path, 3).is_err());
    assert!(read_bounded(root.path(), 4096).is_err());
    #[cfg(unix)]
    {
        let linked = root.path().join("linked.json");
        std::os::unix::fs::symlink(&path, &linked).unwrap();
        assert!(read_bounded(&linked, 4).is_err());
        let pipe = root.path().join("pipe");
        let name = std::ffi::CString::new(pipe.as_os_str().as_encoded_bytes()).unwrap();
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let before = Instant::now();
        assert!(read_bounded(&pipe, 4096).is_err());
        assert!(before.elapsed() < Duration::from_secs(1));
    }
}

#[test]
fn direct_test_and_search_commands_route_to_line_adapters() {
    let config = enabled();
    for command in [
        "pytest tests -v",
        "python -m pytest -v",
        "cargo test --workspace",
        "cargo check --workspace",
        "cargo --manifest-path Cargo.toml test",
        "go -C src test ./...",
        "CARGO_TARGET_DIR=/tmp/jev-target cargo test",
        "env CI=1 cargo test",
        "bash -lc 'cargo test --workspace'",
        "cd src && cargo test",
        "npm --prefix vscode-control test",
        "cmake --build build",
    ] {
        assert_eq!(
            route(
                &json!({"tool_name":"Bash","tool_input":{"command":command}}),
                &config
            ),
            Some("output"),
            "{command}"
        );
    }
    for command in [
        "rg -n pattern src",
        "rg -n 'foo|bar' src",
        "rg pattern src",
        "rg --json pattern src",
        "rg --files src",
        "grep -r pattern src",
        "find src -type f",
        "ls -l src",
        "cd src && rg -n pattern .",
        "git ls-files",
        "git -C src ls-files",
        "git grep pattern",
        "git diff --stat",
    ] {
        assert_eq!(
            route(
                &json!({"tool_name":"Bash","tool_input":{"command":command}}),
                &config
            ),
            Some("output"),
            "{command}"
        );
    }
}

#[test]
fn one_switch_controls_every_supported_output() {
    for enabled in [false, true] {
        let config = Config {
            enabled,
            ..self::enabled()
        };
        for command in [
            "cargo test --workspace",
            "rg -n token src",
            "git ls-files",
            "cat output.log",
        ] {
            assert_eq!(
                route(
                    &json!({"tool_name":"Bash","tool_input":{"command":command}}),
                    &config
                ),
                enabled.then_some("output")
            );
        }
        for tool in [
            "mcp__demo__logs",
            "mcp__files__search",
            "Grep",
            "Read",
            "mcp__test__build",
        ] {
            assert_eq!(
                route(&json!({"tool_name":tool}), &config),
                enabled.then_some("output")
            );
        }
        assert_eq!(route(&json!({"tool_name":"apply_patch"}), &config), None);
    }
}

#[test]
fn unsupported_or_compound_specialized_commands_only_preview_output() {
    let config = enabled();
    for command in [
        "rg --context=3 token src",
        "rg -C3 token src",
        "rg --replace=word token src",
        "rg --json --null token src",
        "find src -print0",
        "git ls-files -z",
        "npm run test; echo done",
        "cargo test\necho done",
        "cd src && cargo test && echo done",
        "git diff",
        "git show HEAD",
    ] {
        assert_eq!(
            route(
                &json!({"tool_name":"Bash","tool_input":{"command":command}}),
                &config
            ),
            Some("output"),
            "{command}"
        );
        let event = json!({"tool_name":"Bash","tool_input":{"command":command}});
        assert_eq!(output_format(&event), None);
        assert!(preview_only(&event));
    }
}

#[test]
fn command_lists_and_line_viewers_keep_routes_and_record_formats() {
    let config = enabled();
    for (command, expected) in [
        ("cargo test\n", "test_build"),
        ("cargo test | tee results.log", "test_build"),
        ("rg -n pattern src | head -n 40", "search_listing"),
        ("rg -n pattern src\nrg -n other tests", "search_listing"),
        ("cat first.log; cat second.log", "output"),
        ("cat first.log | tail -n 20", "output"),
        (
            "bash -lc 'cd src && cargo test; cargo test --doc'",
            "test_build",
        ),
        ("cd src\ncat first.log\ncat second.log", "output"),
    ] {
        let event = json!({"tool_name":"Bash","tool_input":{"command":command}});
        assert_eq!(output_format(&event), Some(expected), "{command}");
        assert_eq!(route(&event, &config), Some("output"), "{command}");
        let disabled = Config {
            enabled: false,
            ..config.clone()
        };
        assert_eq!(route(&event, &disabled), None, "{command}");
    }
    for command in [
        "rg --files src\nrg -n pattern src",
        "rg --json pattern src; rg -n pattern src",
        "cat log | head -c 200",
        "cargo test | sed 's/error/ok/'",
        "rg pattern src > result",
        "cat $(echo path)",
        "cat log |",
        "cat log &&",
        "cat log & cat other",
        "cat log || cat other",
        "cat log\n# unknown script\necho done",
    ] {
        assert_eq!(
            route(
                &json!({"tool_name":"Bash","tool_input":{"command":command}}),
                &config
            ),
            Some("output"),
            "{command}"
        );
        let event = json!({"tool_name":"Bash","tool_input":{"command":command}});
        assert_eq!(output_format(&event), None);
        assert!(preview_only(&event));
    }
}

#[test]
fn local_text_is_eligible_but_structured_and_action_results_are_not() {
    let config = enabled();
    let read = json!({"tool_name":"Read","tool_response":"line one\nline two\n"});
    assert_eq!(route(&read, &config), Some("output"));
    assert_eq!(
        response_text(&read).as_deref(),
        Some("line one\nline two\n")
    );
    let shell = json!({"tool_name":"exec_command","tool_input":{"cmd":"rg -n token src"},
        "tool_response":{"output":"src/a.rs:12:token\n","exit_code":0}});
    assert_eq!(route(&shell, &config), Some("output"));
    assert_eq!(
        response_text(&shell).as_deref(),
        Some("Command result metadata: {\"exit_code\":0}\nsrc/a.rs:12:token\n")
    );
    let search = json!({"tool_name":"mcp__files__search","tool_response":{
        "content":[{"type":"text","text":"src/main.rs:42:match"}]}});
    assert_eq!(route(&search, &config), Some("output"));
    assert_eq!(
        response_text(&search).as_deref(),
        Some("src/main.rs:42:match")
    );
    for response in [
        json!([]),
        json!([{"type":"input_text","text":"sample"},{"type":"input_image","image_url":"sample"}]),
        json!({"content":[{"type":"image","data":"sample"}]}),
        json!({"content":[{"type":"text","text":"sample"}],"structuredContent":{"id":1}}),
        json!({"content":[{"type":"text","text":"sample"}],"isError":true}),
    ] {
        assert!(
            response_text(&json!({"tool_name":"mcp__files__search","tool_response":response}))
                .is_none()
        );
    }
    for tool in [
        "apply_patch",
        "functions.apply_patch",
        "update_plan",
        "mcp__files__write_file",
        "mcp__repo__deploy",
        "mcp__keys__getApiKey",
        "mcp__repo__buildAndDeploy",
    ] {
        assert_eq!(route(&json!({"tool_name":tool}), &config), None, "{tool}");
    }
    assert!(sensitive_input(&json!({"tool_input":{"path":".env"}})));
    assert_eq!(
        response_text(&json!({"tool_name":"Read","tool_response":[
            {"type":"input_text","text":"line one"}, {"type":"input_text","text":"line two"}
        ]}))
        .as_deref(),
        Some("line one\nline two")
    );
}

#[test]
fn orchestration_text_previews_command_output_without_losing_unknown_payloads() {
    let config = enabled();
    let text = "INFO routine poll\nERROR synthetic failure\nDone\n";
    let envelope = json!({"chunk_id":"dummy","wall_time_seconds":0.1,
        "exit_code":1,"output":text})
    .to_string();
    for tool in ["exec", "wait", "functions.exec", "functions.wait"] {
        let event = json!({"tool_name":tool,"tool_response":[
            {"type":"input_text","text":"Script completed\nOutput:\n"},
            {"type":"input_text","text":envelope}]});
        assert_eq!(route(&event, &config), Some("output"));
        let preview = response_text(&event).unwrap();
        assert!(preview.contains(text));
        assert!(preview.contains("\"exit_code\":1"));
        assert!(!preview.contains("\\nERROR"));
    }
    let unknown = json!({"chunk_id":"dummy","wall_time_seconds":0.1,
        "output":text,"custom_metadata":{"required":true}})
    .to_string();
    assert_eq!(
        response_text(&json!({"tool_name":"exec","tool_response":[
        {"type":"input_text","text":unknown}]}))
        .unwrap(),
        unknown
    );
    assert!(response_text(&json!({"tool_name":"exec","tool_response":[
        {"type":"input_text","text":envelope},{"type":"input_image"}]}))
    .is_none());
}

#[test]
fn duplicate_command_fields_preserve_the_raw_envelope() {
    for envelope in [
        r#"{"output":"required evidence","output":"routine noise","exit_code":0}"#,
        r#"{"output":"required evidence","exit_code":1,"exit_code":0}"#,
        r#"{"output":"required evidence","\u006futput":"routine noise","exit_code":0}"#,
    ] {
        let event = json!({"tool_name":"exec","tool_response":[
            {"type":"input_text","text":envelope}]});
        assert_eq!(response_text(&event).as_deref(), Some(envelope));
        assert!(!replacement_supported(&event));
    }
}

#[test]
fn completion_and_jsonl_structure_are_protected() {
    let mut build = source_lines("test_one PASSED\n40 passed in 2.1s\n");
    assert!(apply_route_structure(
        "test_build",
        "Bash",
        "pytest -v",
        &mut build
    ));
    assert_eq!(build[1].protected_reason.as_deref(), Some("completion"));
    let source = concat!(
        "{\"type\":\"begin\",\"data\":{}}\n",
        "{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"src/a.rs\"},\"lines\":{\"text\":\"needle\"}}}\n",
        "{\"type\":\"end\",\"data\":{}}\n");
    let mut search = source_lines(source);
    assert!(apply_route_structure(
        "search_listing",
        "Bash",
        "rg --json needle src",
        &mut search
    ));
    assert!(!search[0].eligible);
    assert!(search[1].eligible);
    assert!(!search[2].eligible);
}

#[test]
fn structured_test_and_build_failures_stay_visible() {
    let mut go = source_lines(concat!(
        "{\"Action\":\"output\",\"Package\":\"example/a\",\"Output\":\"case failed\\n\"}\n",
        "{\"Action\":\"fail\",\"Package\":\"example/a\"}\n"
    ));
    assert!(apply_route_structure(
        "test_build",
        "Bash",
        "go test -json ./...",
        &mut go
    ));
    assert_eq!(go[0].protected_reason.as_deref(), Some("diagnostic_json"));
    assert_eq!(go[1].protected_reason.as_deref(), Some("completion"));
    let mut cargo = source_lines(concat!(
        "{\"reason\":\"compiler-message\",\"message\":{\"level\":\"error\",\"message\":\"bad type\"}}\n",
        "{\"reason\":\"build-finished\",\"success\":false}\n"));
    assert!(apply_route_structure(
        "test_build",
        "Bash",
        "cargo build --message-format=json",
        &mut cargo
    ));
    assert_eq!(
        cargo[0].protected_reason.as_deref(),
        Some("diagnostic_json")
    );
    assert_eq!(cargo[1].protected_reason.as_deref(), Some("completion"));
}

#[test]
fn unknown_json_text_is_not_filtered_line_by_line() {
    for route in ["output", "search_listing", "test_build"] {
        let mut lines = source_lines("{\n  \"items\": [1, 2],\n  \"ok\": true\n}\n");
        assert!(!apply_route_structure(route, "Read", "", &mut lines));
    }
}

#[test]
fn completed_batch_is_visible_and_failed_result_restores_empty_panel() {
    let temporary = tempfile::tempdir().unwrap();
    let data = temporary.path().join("data");
    fs::create_dir(&data).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&data, fs::Permissions::from_mode(0o700)).unwrap();
    }
    let lines = source_lines("Compiling module\nDone\n");
    let judged = apply_relevance(&lines, &BTreeMap::from([(1, 0.02)]), 5);
    let path = data.join("logs/latest-decision.json");
    let batch = BatchRecord {
        id: 1,
        target_numbers: vec![1],
        request: json!({}),
        response: json!({}),
        elapsed_ms: 25,
    };
    {
        let mut progress = ProgressSnapshot::new(&data, "a".repeat(32)).unwrap();
        progress
            .publish("output", &lines, &judged, &batch, 1, 1)
            .unwrap();
        let snapshot: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        assert_eq!(snapshot["version"], 6);
        assert_eq!(snapshot["status"], "processing");
        assert_eq!(snapshot["totals"]["judged"], 1);
        assert_eq!(snapshot["rows"][0]["line"], 1);
    }
    assert!(!path.exists());
}

#[test]
fn overlapping_progress_preserves_the_newest_completed_panel() {
    let temporary = tempfile::tempdir().unwrap();
    let data = temporary.path().join("data");
    ensure_dir(&data).unwrap();
    ensure_dir(&data.join("logs")).unwrap();
    let path = data.join("logs/latest-decision.json");
    let previous = json!({"receipt_id":"previous", "status":"keep", "rows":[]});
    write_private(&path, &serde_json::to_vec(&previous).unwrap(), true).unwrap();
    let mut first = ProgressSnapshot::new(&data, "a".repeat(32)).unwrap();
    let mut second = ProgressSnapshot::new(&data, "b".repeat(32)).unwrap();
    let lines = source_lines("routine poll\nDone\n");
    let decisions = apply_relevance(&lines, &BTreeMap::from([(1, 0.02)]), 5);
    let batch = BatchRecord {
        id: 1,
        target_numbers: vec![1],
        request: json!({}),
        response: json!({}),
        elapsed_ms: 1,
    };
    first
        .publish("output", &lines, &decisions, &batch, 1, 2)
        .unwrap();
    second
        .publish("output", &lines, &decisions, &batch, 1, 2)
        .unwrap();
    // A concurrent completion must survive a later failed batch in either hook.
    let completed = json!({"receipt_id":"newest", "status":"replace", "rows":[]});
    write_private(&path, &serde_json::to_vec(&completed).unwrap(), true).unwrap();
    first
        .publish("output", &lines, &decisions, &batch, 2, 2)
        .unwrap();
    drop(second);
    drop(first);
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap(),
        completed
    );
}

#[test]
fn overlapping_failed_hooks_do_not_restore_an_abandoned_processing_panel() {
    let temporary = tempfile::tempdir().unwrap();
    let data = temporary.path().join("data");
    ensure_dir(&data).unwrap();
    let lines = source_lines("routine poll\nDone\n");
    let decisions = apply_relevance(&lines, &BTreeMap::from([(1, 0.02)]), 5);
    let batch = BatchRecord {
        id: 1,
        target_numbers: vec![1],
        request: json!({}),
        response: json!({}),
        elapsed_ms: 1,
    };
    let mut first = ProgressSnapshot::new(&data, "a".repeat(32)).unwrap();
    first
        .publish("output", &lines, &decisions, &batch, 1, 2)
        .unwrap();
    let mut second = ProgressSnapshot::new(&data, "b".repeat(32)).unwrap();
    second
        .publish("output", &lines, &decisions, &batch, 1, 2)
        .unwrap();
    drop(first);
    drop(second);
    assert!(!data.join("logs/latest-decision.json").exists());
}

#[test]
fn large_progress_panels_publish_first_final_and_periodic_updates() {
    let temporary = tempfile::tempdir().unwrap();
    let data = temporary.path().join("data");
    ensure_dir(&data).unwrap();
    let mut progress = ProgressSnapshot::new(&data, "a".repeat(32)).unwrap();
    assert!(progress.should_publish(10_000, 1, 100));
    progress.last_published = Some(Instant::now());
    assert!(!progress.should_publish(10_000, 2, 100));
    assert!(progress.should_publish(10_000, 100, 100));
    assert!(progress.should_publish(72, 2, 100));
    progress.last_published = Some(Instant::now() - Duration::from_secs(1));
    assert!(progress.should_publish(10_000, 3, 100));
}

#[test]
fn expired_deadline_rolls_back_progress_and_records_the_error() {
    struct ResetDeadline(Option<Instant>);
    impl Drop for ResetDeadline {
        fn drop(&mut self) {
            HOOK_STARTED.with(|started| started.set(self.0));
        }
    }
    let _reset = ResetDeadline(HOOK_STARTED.with(|started| started.get()));
    for previous in [None, Some(json!({"receipt_id":"previous", "rows":[]}))] {
        HOOK_STARTED.with(|started| started.set(None));
        let temporary = tempfile::tempdir().unwrap();
        let data = temporary.path().join("data");
        ensure_dir(&data).unwrap();
        let path = data.join("logs/latest-decision.json");
        ensure_dir(&data.join("logs")).unwrap();
        if let Some(value) = &previous {
            write_private(&path, &serde_json::to_vec(value).unwrap(), true).unwrap();
        }
        let mut progress = ProgressSnapshot::new(&data, "a".repeat(32)).unwrap();
        let lines = source_lines("routine poll\nDone\n");
        let decisions = apply_relevance(&lines, &BTreeMap::from([(1, 0.02)]), 5);
        let batch = BatchRecord {
            id: 1,
            target_numbers: vec![1],
            request: json!({}),
            response: json!({}),
            elapsed_ms: 1,
        };
        progress
            .publish("output", &lines, &decisions, &batch, 1, 2)
            .unwrap();
        HOOK_STARTED.with(|started| started.set(Some(Instant::now() - Duration::from_secs(46))));
        assert!(remaining().is_err());
        drop(progress);
        match previous {
            Some(value) => assert_eq!(
                serde_json::from_slice::<Value>(&fs::read(&path).unwrap()).unwrap(),
                value
            ),
            None => assert!(!path.exists()),
        }
        hook_health(&data, "error", "hook deadline").unwrap();
        let health: Value =
            serde_json::from_slice(&fs::read(data.join("logs/hook-health.json")).unwrap()).unwrap();
        assert_eq!(health["last_error"], "hook deadline");
        assert!(health["last_error_ms"].is_number());
    }
}

#[test]
fn panel_snapshot_contains_a_full_bounded_250_line_batch() {
    let source = (1..=250)
        .map(|number| format!("Synthetic line {number:03}: {}\n", "x".repeat(500)))
        .collect::<String>();
    let lines = source_lines(&source);
    let probabilities = (1..=250)
        .map(|number| (number, (0.5, 0.2, None, 1)))
        .collect::<BTreeMap<_, _>>();
    let decisions = apply_probabilities(
        &lines,
        &probabilities,
        &LinePolicy::default(),
        &SearchRelevancePolicy::default(),
    );
    let batch = BatchRecord {
        id: 1,
        target_numbers: (1..=250).collect(),
        request: json!({}),
        response: json!({}),
        elapsed_ms: 25,
    };
    let snapshot = line_snapshot(
        &"a".repeat(32),
        &"b".repeat(32),
        "output",
        "keep",
        &lines,
        &decisions,
        &batch,
        1,
        1,
        1,
    );
    assert_eq!(snapshot["rows"].as_array().unwrap().len(), 250);
    assert!(snapshot["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["excerpt"].as_str().unwrap().encode_utf16().count() <= 120));
    assert!(serde_json::to_vec(&snapshot).unwrap().len() <= PANEL_SNAPSHOT_MAX_BYTES);
}

#[test]
fn cumulative_panel_covers_ten_thousand_lines_including_prior_batches() {
    let source = (1..=10_000)
        .map(|number| format!("Synthetic line {number:05}: {}\n", "漢".repeat(20)))
        .collect::<String>();
    let lines = source_lines(&source);
    let probabilities = (1usize..=10_000)
        .map(|number| (number, (0.03, number.div_ceil(1000))))
        .collect::<BTreeMap<_, _>>();
    let decisions = apply_relevance_batches(&lines, &probabilities, 5);
    let batch = BatchRecord {
        id: 10,
        target_numbers: (9001..=10_000).collect(),
        request: json!({}),
        response: json!({}),
        elapsed_ms: 25,
    };
    let snapshot = line_snapshot(
        &"a".repeat(32),
        &"b".repeat(32),
        "output",
        "candidate",
        &lines,
        &decisions,
        &batch,
        10,
        10,
        1,
    );
    assert_eq!(snapshot["rows"].as_array().unwrap().len(), 10_000);
    assert_eq!(snapshot["rows"][0]["line"], 1);
    assert_eq!(snapshot["rows"][9999]["action"], "keep");
    assert_eq!(snapshot["rows"][9999]["protected_reason"], "last_line");
    let size = serde_json::to_vec(&snapshot).unwrap().len();
    assert!(size > 256 * 1024 && size <= PANEL_SNAPSHOT_MAX_BYTES);
}
