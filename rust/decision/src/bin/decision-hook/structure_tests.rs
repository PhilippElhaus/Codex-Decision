use super::*;

fn native_event(script: &str, stdout: &str, stderr: &str) -> Value {
    let value = json!({"exit_code":1,"stdout":stdout,"stderr":stderr,"duration_ms":20,
        "output_truncated":false,"writable_layer_bytes":4096});
    json!({"tool_name":"mcp__lab_control__lab_session_execute","tool_input":{"script":script},
        "tool_response":{"content":[{"type":"text","text":value.to_string()}],"structuredContent":value}})
}

fn checked(event: &Value) -> (bool, Vec<SourceLine>) {
    let source = response_text(event).unwrap();
    let mut lines = source_lines(&source);
    protect_response_metadata(&mut lines);
    protect_lab_streams(event, &mut lines);
    let accepted = apply_route_structure(
        output_format(event).unwrap(),
        event["tool_name"].as_str().unwrap(),
        command(event),
        &mut lines,
    );
    (accepted, lines)
}

#[test]
fn protected_lab_stderr_does_not_invalidate_stdout_json_or_numbered_contracts() {
    for (command, stdout) in [
        ("go test -json", "{\"Action\":\"run\",\"Package\":\"synthetic\",\"Test\":\"routine\"}\n{\"Action\":\"pass\",\"Package\":\"synthetic\"}\n"),
        ("cargo build --message-format=json", "{\"reason\":\"compiler-artifact\"}\n{\"reason\":\"build-finished\",\"success\":false}\n"),
        ("rg -n value src", "src/routine.rs:1:value=1\nsrc/required.rs:2:value=2\n"),
    ] {
        let (accepted,lines)=checked(&native_event(command,stdout,"ERROR: retained stderr detail\nINFO stderr context\n"));
        assert!(accepted,"protected stderr rejected {command}");
        let stderr=lines.iter().position(|line| line.model_text=="Command result stream: stderr").unwrap();
        assert!(lines[stderr..].iter().all(|line| line.protected_reason.is_some()));
    }
}

#[test]
fn duplicate_jsonl_keys_are_ambiguous_even_inside_valid_streams() {
    for (command, source) in [
        ("go test -json", "{\"Action\":\"fail\",\"Action\":\"pass\",\"Package\":\"synthetic\"}\n"),
        ("cargo build --message-format=json", "{\"reason\":\"compiler-message\",\"reason\":\"build-finished\",\"success\":false}\n"),
        ("rg --json value src", "{\"type\":\"match\",\"data\":{\"path\":{\"text\":\"src/required.rs\",\"text\":\"src/routine.rs\"},\"lines\":{\"text\":\"value=1\\n\"},\"line_number\":2}}\n"),
    ] {
        let event=json!({"tool_name":"Bash","tool_input":{"command":command},"tool_response":source});
        let (accepted,_)=checked(&event);
        assert!(!accepted,"ambiguous JSONL accepted for {command}");
    }
}

#[test]
fn malformed_stdout_remains_rejected_with_protected_stderr() {
    let (accepted, _) = checked(&native_event(
        "go test -json",
        "{invalid stdout}\n",
        "ERROR retained detail\n",
    ));
    assert!(!accepted);
}

#[test]
fn decoded_go_backtrace_continuations_are_protected_past_the_short_context_window() {
    let mut rows = vec![json!({"Action":"output","Package":"synthetic","Test":"failing", "Output":"panic: synthetic failure\nstack backtrace:\n"}).to_string()];
    rows.extend((0..60).map(|index| json!({"Action":"output","Package":"synthetic","Test":"failing", "Output":format!("    synthetic/frame_{index}.go:42\n")}).to_string()));
    rows.push(json!({"Action":"fail","Package":"synthetic"}).to_string());
    let event = json!({"tool_name":"Bash","tool_input":{"command":"go test -json"},"tool_response":rows.join("\n")});
    let (accepted, mut lines) = checked(&event);
    assert!(accepted);
    protect_neighbors(&mut lines);
    for line in &lines[1..61] {
        assert!(
            line.protected_reason.is_some(),
            "backtrace frame {} became eligible",
            line.number
        );
    }
}

#[test]
fn decoded_go_stack_frames_are_protected_when_the_chunk_starts_mid_trace() {
    let output = |test: &str, text: &str| {
        json!({"Action":"output","Package":"synthetic","Test":test,"Output":text}).to_string()
    };
    let mut rows = vec![
        output("crashing", "main.synthetic(0xc000012345)\n"),
        output("crashing", "\t/synthetic/main.go:42 +0x1a\n"),
        output("unrelated", "INFO normal independent observation\n"),
        output("crashing", "goroutine 19 [running]:\n"),
        output("crashing", "created by main.synthetic in goroutine 1\n"),
        output("crashing", "\t/synthetic/start.go:17 +0x2b\n"),
    ];
    rows.push(json!({"Action":"fail","Package":"synthetic"}).to_string());
    let (accepted, lines) = checked(&native_event("go test -json", &rows.join("\n"), ""));
    assert!(accepted);
    // Lab protects only the first/last chunk boundaries. Interior stack
    // frames need their own typed contract even without the earlier panic.
    for index in [3, 5, 6, 7] {
        assert!(
            lines[index].protected_reason.is_some(),
            "mid-trace frame became a provider target: {}",
            lines[index].model_text
        );
    }
    assert!(
        lines[4].protected_reason.is_none(),
        "unrelated interleaved log became coupled to another test"
    );
}

#[test]
fn known_jsonl_semantic_fields_require_their_producer_types() {
    for (command, row, completion) in [
        (
            "go test -json",
            json!({"Action":"output","Package":"synthetic"}),
            json!({"Action":"pass","Package":"synthetic"}),
        ),
        (
            "go test -json",
            json!({"Action":"output","Package":"synthetic","Output":true}),
            json!({"Action":"pass","Package":"synthetic"}),
        ),
        (
            "go test -json",
            json!({"Action":"output","Package":"synthetic","Output":17}),
            json!({"Action":"pass","Package":"synthetic"}),
        ),
        (
            "cargo build --message-format=json",
            json!({"reason":"build-finished"}),
            json!({"reason":"build-finished","success":true}),
        ),
        (
            "cargo build --message-format=json",
            json!({"reason":"build-finished","success":"false"}),
            json!({"reason":"build-finished","success":true}),
        ),
    ] {
        let source = format!("{row}\n{completion}\n");
        let event =
            json!({"tool_name":"Bash","tool_input":{"command":command},"tool_response":source});
        assert!(
            !checked(&event).0,
            "malformed producer field accepted: {row}"
        );
    }
}

#[test]
fn go_bench_action_is_a_supported_producer_event() {
    let source = "{\"Action\":\"bench\",\"Package\":\"synthetic\",\"Test\":\"BenchmarkSynthetic\"}\n{\"Action\":\"pass\",\"Package\":\"synthetic\",\"Elapsed\":0.002}\n";
    let event =
        json!({"tool_name":"Bash","tool_input":{"command":"go test -json"},"tool_response":source});
    let (accepted, lines) = checked(&event);
    assert!(accepted);
    assert_eq!(
        lines[0].protected_reason.as_deref(),
        Some("benchmark_result")
    );
}

#[test]
fn go_trace_continuation_does_not_consume_unrelated_tests_or_post_terminal_output() {
    let row = |test: &str, output: &str| {
        json!({"Action":"output","Package":"synthetic","Test":test,"Output":output}).to_string()
    };
    let mut rows = vec![row(
        "failing",
        "panic: synthetic failure\nstack backtrace:\n",
    )];
    for index in 0..60 {
        rows.push(row("failing", &format!("    frame_{index}.go:42\n")));
        rows.push(row("unrelated", &format!("INFO routine cycle {index}\n")));
    }
    rows.push(json!({"Action":"fail","Package":"synthetic","Test":"failing"}).to_string());
    rows.push(row("failing", "INFO ordinary post-terminal output\n"));
    rows.push(json!({"Action":"fail","Package":"synthetic"}).to_string());
    let event = json!({"tool_name":"Bash","tool_input":{"command":"go test -json"},"tool_response":rows.join("\n")});
    let (accepted, mut lines) = checked(&event);
    assert!(accepted);
    protect_neighbors(&mut lines);
    assert!(
        lines[119].protected_reason.is_some(),
        "final failing frame lost its protection"
    );
    assert!(
        lines[120].protected_reason.is_none(),
        "unrelated test was coupled to the long trace"
    );
    assert!(
        lines[122].protected_reason.is_none(),
        "terminal action did not reset typed trace state"
    );
}

#[test]
fn go_unique_benchmark_measurements_are_protected_even_without_a_test_field() {
    let rows = [
        json!({"Action":"output","Package":"synthetic","Output":"BenchmarkSynthetic-8 100 12.345 ns/op 42 B/op 2 allocs/op\n"}),
        json!({"Action":"output","Package":"synthetic","Test":"BenchmarkOther","Output":"custom latency = 0.0042 seconds\n"}),
        json!({"Action":"bench","Package":"synthetic","Test":"BenchmarkOther","Elapsed":0.002}),
        json!({"Action":"pass","Package":"synthetic","Elapsed":0.003}),
    ];
    let source = rows
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    let event =
        json!({"tool_name":"Bash","tool_input":{"command":"go test -json"},"tool_response":source});
    let (accepted, lines) = checked(&event);
    assert!(accepted);
    assert!(lines[..3]
        .iter()
        .all(|line| line.protected_reason.as_deref() == Some("benchmark_result")));
}

#[test]
fn go_runtime_panic_frames_with_blank_and_unindented_function_rows_stay_protected() {
    let row = |output: &str| {
        json!({"Action":"output","Package":"synthetic","Test":"failing","Output":output})
            .to_string()
    };
    let mut rows = vec![
        row("panic: synthetic failure\n"),
        row("\n"),
        row("goroutine 9 [running]:\n"),
    ];
    for index in 0..60 {
        rows.push(row(&format!("synthetic.example/frame_{index}(0x1234)\n")));
        rows.push(row(&format!("\t/synthetic/frame_{index}.go:42 +0x1a\n")));
    }
    rows.push(json!({"Action":"fail","Package":"synthetic"}).to_string());
    let event = json!({"tool_name":"Bash","tool_input":{"command":"go test -json"},"tool_response":rows.join("\n")});
    let (accepted, mut lines) = checked(&event);
    assert!(accepted);
    protect_neighbors(&mut lines);
    assert!(
        lines[2..123]
            .iter()
            .all(|line| line.protected_reason.is_some()),
        "Go runtime stack frames became removal targets"
    );
}

#[test]
fn cargo_notes_help_and_future_diagnostic_levels_keep_the_complete_record() {
    for level in [
        "error",
        "warning",
        "note",
        "help",
        "failure-note",
        "future-diagnostic",
    ] {
        let row=json!({"reason":"compiler-message","message":{"level":level,"message":"required context",
            "children":[{"level":"help","message":"required hint"}],"spans":[{"file_name":"src/example.rs","byte_start":12,"byte_end":18}]}}).to_string();
        let source = format!("{row}\n{{\"reason\":\"build-finished\",\"success\":false}}\n");
        let event = json!({"tool_name":"Bash","tool_input":{"command":"cargo build --message-format=json"},"tool_response":source});
        let (accepted, lines) = checked(&event);
        assert!(accepted, "{level}");
        assert_eq!(
            lines[0].protected_reason.as_deref(),
            Some("diagnostic_json")
        );
        assert_eq!(lines[0].model_text, row, "diagnostic metadata was changed");
    }
    for message in [
        json!({}),
        json!(true),
        json!({"level":"note"}),
        json!({"level":true,"message":"context"}),
        json!({"level":"help","message":17}),
    ] {
        let source = format!(
            "{}\n{{\"reason\":\"build-finished\",\"success\":false}}\n",
            json!({"reason":"compiler-message","message":message})
        );
        let event = json!({"tool_name":"Bash","tool_input":{"command":"cargo build --message-format=json"},"tool_response":source});
        assert!(
            !checked(&event).0,
            "invalid diagnostic carrier accepted: {message}"
        );
    }
}

#[test]
fn cargo_json_message_formats_require_real_options_and_a_pure_json_carrier() {
    let source =
        "{\"reason\":\"compiler-artifact\"}\n{\"reason\":\"build-finished\",\"success\":true}\n";
    for command in [
        "cargo build --message-format=json", "cargo build --message-format json",
        "cargo build --message-format=json,json-diagnostic-short",
        "cargo build --message-format=json --message-format json-diagnostic-rendered-ansi",
        "cargo build --message-format json; cargo build --message-format=json,json-diagnostic-short",
    ] {
        let event=json!({"tool_name":"Bash","tool_input":{"command":command},"tool_response":source});
        assert!(checked(&event).0,"valid Cargo JSON option rejected: {command}");
    }
    for command in [
        "cargo test -- --message-format=json",
        "cargo build --features '--message-format=json'",
        "cargo build --message-format=json,human",
        "cargo build --message-format=json --message-format=short",
        "cargo build --message-format=json,json-render-diagnostics",
        "cargo build --message-format=json,unknown",
        "cargo build --message-format",
        "cargo build --message-format=json,",
    ] {
        let event =
            json!({"tool_name":"Bash","tool_input":{"command":command},"tool_response":source});
        assert!(
            !checked(&event).0,
            "invalid/non-option format claimed JSON carrier: {command}"
        );
    }
}

#[test]
fn coupled_json_after_plain_build_headers_does_not_acquire_independent_line_contracts() {
    for source in [
        "Building synthetic component\n{\n  \"latency\":42,\n  \"routine\":\"steady\"\n}\nBuild successful\n",
        "Building synthetic component\n{\"latency\":42,\n  \"routine\":\"steady\"\n}\nBuild successful\n",
        "Building synthetic component\n[\n  42,\n  17\n]\nBuild successful\n",
        "Building synthetic component\n[1/2] {\n  \"latency\":42\n}\nBuild successful\n",
        "ERROR: compiler source excerpt\n{\n  \"latency\":42\n}\nBuild successful\n",
    ] {
        let event=json!({"tool_name":"Bash","tool_input":{"command":"cmake --build build"},"tool_response":source});
        assert!(!checked(&event).0,"unknown machine payload after a header was treated as independent rows");
    }
    for source in [
        "Building synthetic component\n{\"latency\":42,\"routine\":\"steady\"}\nBuild successful\n",
        "[ 42%] Building CXX object synthetic.o\n[100%] Built target synthetic\nBuild successful\n",
        "[37/180] Building synthetic component\nBuild successful\n",
        "[0/248] Compiling component_0 ... done\nBuild successful\n",
        "[252/252] Compiling shard_252 ... done\nBuild successful\n",
        "test synthetic_case ... ok\n1 passed in 0.01s\n",
    ] {
        let event = json!({"tool_name":"Bash","tool_input":{"command":"cmake --build build"},"tool_response":source});
        assert!(
            checked(&event).0,
            "independent build records rejected: {source}"
        );
    }
    let (accepted, lines) = checked(&native_event(
        "cmake --build build",
        "Building synthetic component\nBuild successful\n",
        "{\n  \"required\":42\n}\n",
    ));
    assert!(
        accepted,
        "fully protected stderr should not change the stdout contract"
    );
    assert!(lines
        .iter()
        .filter(|line| line.model_text.contains("required"))
        .all(|line| line.protected_reason.as_deref() == Some("stderr_output")));
}

#[test]
fn ripgrep_match_evidence_keeps_submatch_offsets_and_full_record() {
    let source = r#"{"type":"match","data":{"path":{"text":"src/example.rs"},"lines":{"text":"FOO BAR\n"},"line_number":7,"absolute_offset":4096,"submatches":[{"match":{"text":"BAR"},"start":4,"end":7}]}}"#;
    let event = json!({"tool_name":"Bash","tool_input":{"command":"rg --json BAR src"},"tool_response":source});
    let (accepted, lines) = checked(&event);
    assert!(accepted);
    assert_eq!(
        lines[0].model_text, source,
        "The provider must see the complete independent match record"
    );
}

#[test]
fn ripgrep_match_text_path_and_line_numbers_require_unambiguous_supported_types() {
    for (path, text, number) in [
        (
            json!({"bytes":"c3JjL2V4YW1wbGUucnM="}),
            json!({"text":"value\n"}),
            json!(1),
        ),
        (
            json!({"text":"src/a.rs","bytes":"YQ=="}),
            json!({"text":"value\n"}),
            json!(1),
        ),
        (
            json!({"text":"src/a.rs"}),
            json!({"bytes":"dmFsdWU="}),
            json!(1),
        ),
        (json!({"text":""}), json!({"text":"value\n"}), json!(1)),
        (json!({"text":17}), json!({"text":"value\n"}), json!(1)),
        (json!({"text":"src/a.rs"}), json!({"text":null}), json!(1)),
        (
            json!({"text":"src/a.rs"}),
            json!({"text":"value\n"}),
            json!(0),
        ),
        (
            json!({"text":"src/a.rs"}),
            json!({"text":"value\n"}),
            json!(-1),
        ),
        (
            json!({"text":"src/a.rs"}),
            json!({"text":"value\n"}),
            json!("1"),
        ),
        (
            json!({"text":"src/a.rs"}),
            json!({"text":"value\n"}),
            Value::Null,
        ),
    ] {
        let row = json!({"type":"match","data":{"path":path,"lines":text,"line_number":number}})
            .to_string();
        let event = json!({"tool_name":"Bash","tool_input":{"command":"rg --json value src"},"tool_response":row});
        assert!(!checked(&event).0);
    }
}
