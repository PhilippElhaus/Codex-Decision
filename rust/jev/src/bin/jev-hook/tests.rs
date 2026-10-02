use super::*;

#[test]
fn old_or_unknown_config_never_looks_disabled() {
    let directory = tempfile::tempdir().unwrap();
    for value in [
        json!({"enabled":true}),
        json!({"schema_version":1,"enabled":true}),
        json!({"schema_version":3,"enabled":true}),
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
    assert!(selected.output);
    assert!(!selected.test_build);
    assert!(selected.search_listing);
    assert_eq!(selected.mode, "observe");
    assert_eq!(selected.policy["output"].omit_min, 80);
    assert!(selected.search_relevance.guard_enabled);
    assert!(!selected.choice_gate_enabled);
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
    hook_health(&data, "error", "invalid Jev response").unwrap();
    let bytes = fs::read(data.join("logs/hook-health.json")).unwrap();
    let status: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(status["last_skip"], "small");
    assert_eq!(status["skipped"], 1);
    assert_eq!(status["last_error"], "invalid Jev response");
    assert!(!String::from_utf8_lossy(&bytes).contains("tool_response"));
    hook_health(&data, "success", "").unwrap();
    let updated: Value =
        serde_json::from_slice(&fs::read(data.join("logs/hook-health.json")).unwrap()).unwrap();
    assert!(updated["last_success_ms"].as_i64() >= status["last_error_ms"].as_i64());
}

fn enabled() -> Config {
    Config {
        global_scope: false,
        output: true,
        test_build: true,
        search_listing: true,
        choice_gate_enabled: true,
        mode: "observe".into(),
        min_chars: 1024,
        max_chars: 2_000_000,
        model: "jev-latest".into(),
        timeout: 3.0,
        allow_mcp_replacement: false,
        policy: BTreeMap::new(),
        search_relevance: SearchRelevancePolicy::default(),
        log_limit_mb: 50,
        never_delete_logs: false,
    }
}

#[test]
fn choice_gate_rejects_inconsistent_answers_and_keeps_uncertainty() {
    let answer = |choice: &str, confidence: f64, filter: f64, full: f64, uncertain: f64| {
        json!({"answers":{"line_filter_fit":{"type":"choice","choice":choice,
            "confidence":confidence,"probabilities":{"line_filter":filter,
                "keep_full":full,"uncertain":uncertain}}}})
    };
    assert!(choice_allows_line_filter(&answer("line_filter", 0.96, 0.98, 0.01, 0.01)).unwrap());
    assert!(!choice_allows_line_filter(&answer("keep_full", 0.96, 0.01, 0.98, 0.01)).unwrap());
    assert!(!choice_allows_line_filter(&answer("uncertain", 0.01, 0.33, 0.33, 0.34)).unwrap());
    assert!(!choice_allows_line_filter(&answer("line_filter", 0.60, 0.80, 0.10, 0.10)).unwrap());
    for bad in [
        answer("line_filter", 0.96, 0.49, 0.50, 0.01),
        answer("line_filter", 0.96, 0.98, 0.98, 0.01),
        answer("other", 0.96, 0.98, 0.01, 0.01),
        json!({"answers":{"line_filter_fit":{"type":"choice","choice":"line_filter"}}}),
    ] {
        assert!(choice_allows_line_filter(&bad).is_err());
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
        let batch = pack_batches(
            "output",
            "Check progress",
            "echo progress",
            &lines,
            "jev-latest",
        )
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
        config.policy.insert("output".into(), LinePolicy::default());
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
            Some("test_build"),
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
            Some("search_listing"),
            "{command}"
        );
    }
}

#[test]
fn integration_switches_select_exclusive_routes() {
    let cases = [
        ("cargo test --workspace", "test_build"),
        ("rg -n token src", "search_listing"),
        ("git ls-files", "search_listing"),
        ("cat output.log", "output"),
    ];
    for output in [false, true] {
        for test_build in [false, true] {
            for search_listing in [false, true] {
                let config = Config {
                    output,
                    test_build,
                    search_listing,
                    ..enabled()
                };
                for (command, expected_route) in cases {
                    let selected = match expected_route {
                        "output" => output,
                        "test_build" => test_build,
                        _ => search_listing,
                    };
                    assert_eq!(
                        route(
                            &json!({"tool_name":"Bash","tool_input":{"command":command}}),
                            &config
                        ),
                        selected.then_some(expected_route),
                        "{command} with output={output}, test_build={test_build}, search_listing={search_listing}"
                    );
                }
                assert_eq!(
                    route(&json!({"tool_name":"mcp__demo__logs"}), &config),
                    output.then_some("output")
                );
                assert_eq!(
                    route(&json!({"tool_name":"mcp__files__search"}), &config),
                    search_listing.then_some("search_listing")
                );
                assert_eq!(
                    route(&json!({"tool_name":"Grep"}), &config),
                    search_listing.then_some("search_listing")
                );
                assert_eq!(
                    route(&json!({"tool_name":"Read"}), &config),
                    output.then_some("output")
                );
                assert_eq!(route(&json!({"tool_name":"apply_patch"}), &config), None);
            }
        }
    }
}

#[test]
fn unsupported_or_compound_specialized_commands_do_not_use_output_fallback() {
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
            None,
            "{command}"
        );
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
        assert_eq!(route(&event, &config), Some(expected), "{command}");
        let disabled = Config {
            output: false,
            test_build: false,
            search_listing: false,
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
            None,
            "{command}"
        );
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
    assert_eq!(route(&shell, &config), Some("search_listing"));
    assert_eq!(
        response_text(&shell).as_deref(),
        Some("src/a.rs:12:token\n")
    );
    let search = json!({"tool_name":"mcp__files__search","tool_response":{
        "content":[{"type":"text","text":"src/main.rs:42:match"}]}});
    assert_eq!(route(&search, &config), Some("search_listing"));
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
        "exec",
        "wait",
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
    let judged = apply_probabilities(
        &lines,
        &BTreeMap::from([(1, (0.98, 0.02, None, 1))]),
        &LinePolicy::default(),
        &SearchRelevancePolicy::default(),
    );
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
        assert_eq!(snapshot["version"], 3);
        assert_eq!(snapshot["status"], "processing");
        assert_eq!(snapshot["totals"]["judged"], 1);
        assert_eq!(snapshot["rows"][0]["line"], 1);
    }
    assert!(!path.exists());
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
    );
    assert_eq!(snapshot["rows"].as_array().unwrap().len(), 250);
    assert!(snapshot["rows"]
        .as_array()
        .unwrap()
        .iter()
        .all(|row| row["excerpt"].as_str().unwrap().encode_utf16().count() <= 120));
    assert!(serde_json::to_vec(&snapshot).unwrap().len() <= PANEL_SNAPSHOT_MAX_BYTES);
}
