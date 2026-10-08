use super::*;

#[test]
fn known_counter_progress_uses_the_whole_log_contract_without_command_provenance() {
    let progress = "[1/80] Building CXX object C:\\users\\synthetic\\component.o\n".repeat(80)
        + "Build successful\n";
    assert!(matches!(
        decide("synthetic-worker", &progress),
        FormatDecision::Direct("repetitive_log")
    ));
    let mixed = progress + "This paragraph qualifies the ordering of these build observations.\nIts ordering is needed to explain these observations.\nThe final interpretation requires preserving the preceding qualifications.\n";
    assert!(matches!(
        decide("synthetic-worker", &mixed),
        FormatDecision::Classify
    ));
    for text in [
        "[1/80] {\"path\":42}",
        "[1/80] explanation",
        "[x/80] Building component",
    ] {
        assert!(
            !log_line(text),
            "unrecognized counter record acquired a log contract: {text}"
        );
    }
}

#[test]
fn timestamped_logs_use_the_local_contract_without_classification() {
    for stamp in ["2026-10-08T12:00:00Z", "2026-10-08T14:00:00.123+02:00"] {
        let source = format!("{stamp} INFO heartbeat idle\n").repeat(20)
            + &format!("{stamp} ERROR synthetic connection refused\n{stamp} INFO run complete\n");
        assert!(matches!(
            decide("synthetic-worker", &source),
            FormatDecision::Direct("repetitive_log")
        ));
    }
    for text in [
        "2026-10-08T12:00:00Z source text",
        "2026-99-99T99:99:99Z INFO idle",
        "prefix INFO idle",
    ] {
        assert!(!log_line(text));
    }
}

fn decide(command: &str, source: &str) -> FormatDecision {
    let mut lines = source_lines(source);
    protect_neighbors(&mut lines);
    format_decision(
        &json!({"tool_name":"Bash","tool_input":{"command":command}}),
        &mut lines,
    )
}

#[test]
fn known_formats_use_semantics_without_a_classification_gate() {
    let progress = "Compiling alpha\nCompiling beta\nFinished release profile\n";
    assert!(matches!(
        decide("cargo build", progress),
        FormatDecision::Direct("progress_output")
    ));
    assert!(matches!(
        decide(
            "rg -n timeout src",
            "src/a.rs:12:timeout=7\nsrc/b.rs:18:timeout=9\n"
        ),
        FormatDecision::Direct("independent_matches")
    ));
    assert!(matches!(
        decide("rg --files src", "src/a.rs\nsrc/b.rs\n"),
        FormatDecision::Direct("independent_records")
    ));
    assert!(matches!(
        decide("cargo build", "Compiling alpha\n"),
        FormatDecision::Keep("structure_guard")
    ));
    assert!(matches!(
        decide(
            "rg -n timeout src",
            "required result without a line number\n"
        ),
        FormatDecision::Keep("structure_guard")
    ));
}

#[test]
fn scripts_require_a_known_log_and_exact_reads_stay_complete() {
    let log = "INFO routine poll\n".repeat(30) + "ERROR: connection refused\nDone\n";
    assert!(matches!(
        decide("python3 - <<'PY'\nprint('log')\nPY", &log),
        FormatDecision::Direct("repetitive_log")
    ));
    assert!(matches!(
        decide("cat synthetic.conf", &log),
        FormatDecision::Keep("exact_content")
    ));
    assert!(matches!(
        decide("git diff", &log),
        FormatDecision::Keep("exact_content")
    ));
    let mixed="INFO routine poll\n".repeat(30)+"The next sentence qualifies this result.\nIts ordering is necessary to understand the explanation.\n";
    assert!(matches!(
        decide("python3 script.py", &mixed),
        FormatDecision::Classify
    ));
    assert!(matches!(
        decide("cat output.log", "{\n\"entries\": []\n}\n"),
        FormatDecision::Keep("structure_guard")
    ));
}

#[test]
fn extensionless_file_reads_cannot_acquire_a_log_contract() {
    let log = "INFO required configuration row\n".repeat(30) + "Done\n";
    for command in [
        "cat LICENSE",
        "cat -- README",
        "head -n 40 Config",
        "tail -n 40 Config",
        "sed -n '1,40p' Config",
        "cat progress.log Config",
        "cat <<'EOF'\nINFO configuration row\nEOF",
        "cat 'source|Config' | sed -n '1,40p'",
    ] {
        assert!(
            matches!(decide(command, &log), FormatDecision::Keep("exact_content")),
            "{command}"
        );
    }
    for command in [
        "cat progress.log",
        "head -n 40 progress.log",
        "tail --lines 40 -- progress.log",
        "sed -n '1,40p' progress.log",
        "sed -e '1,40p' -n -- progress.log",
        "cat progress.log | sed -n '1,40p'",
    ] {
        assert!(
            matches!(
                decide(command, &log),
                FormatDecision::Direct("repetitive_log")
            ),
            "{command}"
        );
    }
}

#[test]
fn file_tools_preserve_source_and_allow_explicit_logs() {
    let log = "INFO required configuration row\n".repeat(30) + "Done\n";
    for (tool, field) in [("Read", "file_path"), ("mcp__files__read_file", "path")] {
        for path in [None, Some("Config"), Some("source.rs")] {
            let input = path.map(|path| json!({field:path})).unwrap_or(json!({}));
            let event = json!({"tool_name":tool,"tool_input":input});
            assert!(matches!(
                format_decision(&event, &mut source_lines(&log)),
                FormatDecision::Keep("exact_content")
            ));
        }
        let event = json!({"tool_name":tool,"tool_input":{field:"service.log"}});
        assert!(matches!(
            format_decision(&event, &mut source_lines(&log)),
            FormatDecision::Direct("repetitive_log")
        ));
    }
    let event = json!({"tool_name":"Read","tool_input":{
        "file_path":"Config","path":"service.log"}});
    assert!(matches!(
        format_decision(&event, &mut source_lines(&log)),
        FormatDecision::Keep("exact_content")
    ));
}

#[test]
fn diff_content_overrides_summary_flags() {
    let diff = "diff --git a/source b/source\n--- a/source\n+++ b/source\n@@ -1 +1 @@\n-INFO old value\n+INFO new value\n";
    for command in ["git diff --stat --patch", "git show --stat -p"] {
        assert!(
            matches!(decide(command, diff), FormatDecision::Keep("exact_content")),
            "{command}"
        );
    }
}

#[test]
fn known_envelopes_keep_metadata_and_unknown_fields_never_gain_replacement() {
    let output = "INFO routine poll\n".repeat(50) + "ERROR: connection refused\nDone\n";
    let body = json!({"output":output,"session_id":12345,"exit_code":1,"wall_time_seconds":0.5});
    let event = json!({"tool_name":"exec_command","tool_response":body});
    assert!(replacement_supported(&event));
    let source = response_text(&event).unwrap();
    let mut lines = source_lines(&source);
    protect_response_metadata(&mut lines);
    assert_eq!(lines[0].protected_reason.as_deref(), Some("tool_metadata"));
    assert!(lines[0].model_text.contains("\"session_id\":12345"));
    let known =
        json!({"tool_name":"exec","tool_response":[{"type":"input_text","text":body.to_string()}]});
    assert!(replacement_supported(&known));
    let unknown = json!({"tool_name":"exec","tool_response":[{"type":"input_text","text":json!({"output":output,"custom_metadata":{"required":true}}).to_string()}]});
    assert!(!replacement_supported(&unknown));
    assert!(!replacement_supported(
        &json!({"tool_name":"exec","tool_response":[
        {"type":"input_text","text":body.to_string(),"annotations":{"required":true}}]})
    ));
    assert!(!replacement_supported(
        &json!({"tool_name":"exec","tool_response":[
        {"type":"input_text","text":body.to_string()},{"type":"input_image"}]})
    ));
}

#[test]
fn wrappers_preserve_metadata_and_validate_independent_search_rows() {
    let event = json!({"tool_name":"exec","tool_response":[{"type":"input_text","text":json!({
        "output":"src/a.rs:1:timeout=7\nsrc/b.rs:2:retry=9\nsrc/c.rs:3:unrelated=1\n","exit_code":0}).to_string()}]});
    let mut lines = source_lines(&response_text(&event).unwrap());
    protect_response_metadata(&mut lines);
    assert!(matches!(
        format_decision(&event, &mut lines),
        FormatDecision::Direct("independent_matches")
    ));
    assert_eq!(lines[0].protected_reason.as_deref(), Some("tool_metadata"));
    let source="This is a connected explanation.\nIts qualifications require the preceding paragraph.\nThe conclusion follows from both statements.\n";
    let event = json!({"tool_name":"mcp__demo__search","tool_response":source});
    assert!(matches!(
        format_decision(&event, &mut source_lines(source)),
        FormatDecision::Classify
    ));
    let event = json!({"tool_name":"exec_command","tool_input":{"cmd":"rg -n timeout src"},
        "tool_response":{"output":"src/a.rs:1:timeout=7\nsrc/b.rs:2:timeout=9\n","exit_code":0}});
    let mut lines = source_lines(&response_text(&event).unwrap());
    protect_response_metadata(&mut lines);
    assert!(matches!(
        format_decision(&event, &mut lines),
        FormatDecision::Direct("independent_matches")
    ));
}

#[test]
fn sparse_facts_stay_protected_and_supply_context_to_every_batch() {
    let mut source = (0..400)
        .map(|n| format!("INFO routine check {n}\n"))
        .collect::<Vec<_>>();
    source[150] = "expected count = 6000\n".into();
    source[151] = "actual count = 5998\n".into();
    let source = source.concat() + "Done\n";
    let event = json!({"tool_name":"Bash","tool_input":{"command":"python3 custom_script.py"}});
    let mut lines = source_lines(&source);
    assert!(matches!(
        format_decision(&event, &mut lines),
        FormatDecision::Direct("repetitive_log")
    ));
    assert_eq!(
        lines[150].protected_reason.as_deref(),
        Some("unrecognized_log_context")
    );
    assert_eq!(
        lines[151].protected_reason.as_deref(),
        Some("unrecognized_log_context")
    );
    let batches = relevance_requests(
        "Compare expected and actual counts",
        "python3 custom_script.py",
        "repetitive_log",
        &lines,
        "jev-latest",
    )
    .unwrap();
    assert!(batches.len() > 1);
    for batch in batches {
        assert!(!batch.target_numbers.contains(&151));
        assert!(!batch.target_numbers.contains(&152));
        let state = batch.request["state"]["lines"].as_array().unwrap();
        assert!(state
            .iter()
            .any(|line| line["text"] == "expected count = 6000" && line["protected"] == true));
        assert!(state
            .iter()
            .any(|line| line["text"] == "actual count = 5998" && line["protected"] == true));
    }
}

#[test]
fn savings_bound_preserves_short_and_heavily_protected_output() {
    let source = "INFO routine check\n".repeat(50);
    let lines = source_lines(&source);
    assert!(savings_possible(
        &source,
        &lines,
        Path::new("/private/original.txt"),
        false
    ));
    let source = "INFO check\n".repeat(15);
    assert!(!savings_possible(
        &source,
        &source_lines(&source),
        Path::new("/private/original.txt"),
        false
    ));
    let source = "ERROR: required diagnostic and exact value\n".repeat(50);
    assert!(!savings_possible(
        &source,
        &source_lines(&source),
        Path::new("/private/original.txt"),
        false
    ));
}
