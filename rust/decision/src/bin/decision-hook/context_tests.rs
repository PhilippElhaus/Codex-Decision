use super::*;

#[test]
fn known_progress_with_windows_paths_is_not_ambiguous_json_but_secrets_stay_guarded() {
    for text in [
        r"[1/80] Building CXX object C:\users\synthetic\component.o",
        r"[ 42%] Building CXX object C:\users\synthetic\component.o",
        "[1/80] \x1b[32mBuilding CXX object C:\\users\\synthetic\\component.o\x1b[0m",
    ] {
        assert!(
            !sensitive_source(text),
            "known safe progress rejected: {text}"
        );
    }
    for text in [
        r"[1/80] Building CXX object API_KEY=synthetic-sentinel-only",
        r"[42%] Building CXX object API\u005fKEY=synthetic-sentinel-only",
        "[1/80] Building CXX object API_\x1b[31mKEY=synthetic-sentinel-only",
        r#"[1/80] {"path":"C:\users\synthetic\component.o""#,
        r#"[42%] {"path":"C:\users\synthetic\component.o""#,
    ] {
        assert!(
            sensitive_source(text),
            "unknown JSON or secret progress escaped guard: {text}"
        );
    }
}

#[test]
fn literal_json_path_roles_do_not_inherit_expression_reference_exemptions() {
    for field in [
        "manifest_path",
        "src_path",
        "file_name",
        "out_dir",
        "path",
        "filePath",
    ] {
        let source = json!({field:"render(process.env.TOKEN)"}).to_string();
        assert!(
            !sensitive(&source),
            "exercise the semantic role guard: {source}"
        );
        assert!(
            sensitive_source(&source),
            "literal filename role bypassed guard: {source}"
        );
        let nested = json!({"Action":"output","Package":"synthetic","Output":source}).to_string();
        assert!(
            sensitive_source(&nested),
            "decoded nested filename role bypassed guard: {nested}"
        );
        let nested = json!({"Output":nested}).to_string();
        assert!(
            sensitive_source(&nested),
            "second nested filename role bypassed guard: {nested}"
        );
    }
    for source in [
        r#"{"command":"const value = process.env.TOKEN;"}"#,
        r#"{"manifest_path":"src/synthetic/Cargo.toml"}"#,
        "INFO renderer checked reference (process.env.TOKEN);\nDone\n",
    ] {
        assert!(
            !sensitive_source(source),
            "ordinary reference became a filename: {source}"
        );
        let nested = json!({"Action":"output","Package":"synthetic","Output":source}).to_string();
        assert!(
            !sensitive_source(&nested),
            "safe nested source became protected: {nested}"
        );
    }
    assert!(sensitive_input(
        &json!({"tool_input":{"path":r"render(process.\u0065nv.TOKEN)"}})
    ));
    assert!(!sensitive_input(
        &json!({"tool_input":{"command":r"const value = process.\u0065nv.TOKEN;"}})
    ));
}

#[test]
fn context_guards_match_encoded_and_colored_provider_strings_without_parsing_code() {
    for text in [
        r"synthetic-worker --API\u005fKEY=synthetic-sentinel",
        "synthetic-worker --API_\x1b[31mKEY=synthetic-sentinel\x1b[0m",
    ] {
        assert!(sensitive_context(text), "context marker missed: {text}");
        assert!(sensitive_input(&json!({"tool_input":{"command":text}})));
    }
    for text in [
        r"C:\users\synthetic\safe.txt",
        "const value = process.env.TOKEN;",
        r"literal \u005f names an underscore",
        r"const pattern = '\u0073';",
    ] {
        assert!(
            !sensitive_context(text),
            "safe code/path/doc rejected: {text}"
        );
        assert!(!sensitive_input(&json!({"tool_input":{"command":text}})));
    }
}

#[test]
fn fallback_cue_normalization_cannot_forward_a_new_credential_marker() {
    for query in [
        "Bearer\tsynthetic-sentinel",
        r"API\u005fKEY=synthetic-sentinel",
        "API_\x1b[31mKEY=synthetic-sentinel\x1b[0m",
    ] {
        let task = fallback_task(&json!({"tool_input":{"query":query}}));
        assert!(
            !task.contains("synthetic-sentinel"),
            "fallback task leaked private cue: {task}"
        );
        assert!(!sensitive_context(&task));
    }
}

#[test]
fn large_ordinary_logs_keep_the_fast_guard_path_and_valid_json_filenames_stay_safe() {
    let ordinary = "INFO ordinary synthetic background event observed without diagnostic details\n"
        .repeat(10_000);
    let windows = r"INFO ordinary path C:\users\synthetic\safe.txt".to_owned() + "\n";
    let windows = windows.repeat(10_000);
    let unicode = (r"INFO literal \u0073 names an ordinary lowercase character".to_owned() + "\n")
        .repeat(10_000);
    let filenames =
        (json!({"reason":"compiler-artifact","manifest_path":"src/synthetic/Cargo.toml"})
            .to_string()
            + "\n")
            .repeat(10_000);
    for (label, source) in [
        ("ordinary", ordinary),
        ("windows", windows),
        ("unicode-doc", unicode),
        ("json-path", filenames),
    ] {
        let started = Instant::now();
        assert!(
            !sensitive_source(&source),
            "large safe log rejected: {label}"
        );
        eprintln!(
            "synthetic privacy guard {label}: {}bytes {}ms",
            source.len(),
            started.elapsed().as_millis()
        );
    }
}

#[test]
fn escaped_output_json_is_checked_as_decoded_keys_values_and_paths() {
    for text in [
        r#"{"Action":"output","Package":"synthetic","Output":"\u0041PI_KEY=synthetic-sentinel-only\n"}"#,
        r#"{"Action":"output","Package":"synthetic","Output":"\u0042earer synthetic-sentinel-only\n"}"#,
        r#"{"Action":"output","Package":"synthetic","Output":"\u002d----\u0042EGIN \u0050RIVATE \u004bEY-----\n"}"#,
        r#"{"type":"match","data":{"path":{"text":"config.\u0065nv"},"lines":{"text":"safe\n"},"line_number":1}}"#,
        r#"{"type":"match","data":{"path":{"text":"safe.txt"},"lines":{"text":"\u0042earer synthetic-sentinel-only\n"},"line_number":1}}"#,
        r#"{"reason":"compiler-message","message":{"level":"error","message":"\u0041PI_KEY=synthetic-sentinel-only"}}"#,
        r#"{"reason":"compiler-artifact","manifest_path":"settings.\u0065nvironment"}"#,
        r#"{"reason":"compiler-artifact","target":{"src_path":"process.\u0065nv.RETRY_COUNT"}}"#,
        r#"{"reason":"compiler-message","message":{"spans":[{"file_name":"settings.\u0065nvironment"}]}}"#,
        r#"{"\u0061pi_key":"synthetic-sentinel-only"}"#,
        r#"Command result metadata: {"chunk_id":"\u0042earer synthetic-sentinel-only"}"#,
        r#"{"Output":"{\"\\u0061pi_key\":\"synthetic-sentinel-only\"}"}"#,
    ] {
        assert!(
            !sensitive(text),
            "fixture must exercise the decoded guard: {text}"
        );
        assert!(sensitive_source(text), "escaped marker was missed: {text}");
        let mixed = format!("INFO routine safe log\n{text}\nDone\n");
        assert!(sensitive_source(&mixed), "JSONL marker was missed: {text}");
    }
}

#[test]
fn literal_unicode_escaped_markers_in_log_prose_and_nested_output_stay_local() {
    for text in [
        r"INFO API\u005fKEY=synthetic-sentinel-only",
        r"INFO \u0042earer synthetic-sentinel-only",
        r"INFO \u002d----\u0042EGIN \u0050RIVATE \u004bEY-----",
        r#"{"Action":"output","Package":"synthetic","Output":"INFO API\\u005fKEY=synthetic-sentinel-only\n"}"#,
    ] {
        assert!(
            !sensitive(text),
            "fixture must bypass only the raw guard: {text}"
        );
        assert!(
            sensitive_source(text),
            "literal escaped marker was missed: {text}"
        );
    }
}

#[test]
fn source_privacy_checks_the_ansi_cleaned_text_that_the_provider_can_see() {
    let source = "INFO API_\x1b[31mKEY=synthetic-sentinel-only\x1b[0m\n";
    assert!(!sensitive(source));
    assert!(sensitive(&source_lines(source)[0].model_text));
    assert!(sensitive_source(source));
    let nested = json!({"Action":"output","Package":"synthetic","Output":source}).to_string();
    assert!(!sensitive(&nested));
    assert!(sensitive_source(&nested));
    let unsupported = "\x1b[?25lINFO unsupported sequence\n".to_owned() + source;
    assert!(
        !sensitive(&codex_decision::strip_ansi(&unsupported)),
        "whole-source strip stops early, unlike source_lines"
    );
    assert!(sensitive(&source_lines(&unsupported)[1].model_text));
    assert!(sensitive_source(&unsupported));
    let nested = json!({"Action":"output","Package":"synthetic","Output":unsupported}).to_string();
    assert!(sensitive_source(&nested));
}

#[test]
fn decoded_output_guard_preserves_safe_json_and_fails_closed_when_ambiguous() {
    for text in [
        "INFO task-state refreshed\nINFO path C:\\synthetic\\safe.txt\nDone\n",
        "[INFO] routine path C:\\synthetic\\safe.txt\nDone\n",
        "[file] routine path C:\\synthetic\\safe.txt\n[trace] routine path C:\\synthetic\\safe.txt\nDone\n",
        r#"{"Output":"routine \u0073tatus completed\n"}"#,
        "{\n  \"Output\": \"routine \\u0073tatus completed\\n\"\n}",
        r#"{"command":"const value = process.env.ACCESS_TOKEN;","Output":"routine \u0073tatus"}"#,
        r#"Command result metadata: {"chunk_id":"safe\u002didentifier"}"#,
        r"INFO literal \u005f represents an underscore",
        r"INFO API\u005fKEY names an environment variable",
        r"INFO path C:\users\synthetic\docs.txt",
        r"INFO unicode pattern \u0073 matches lowercase s",
        r"INFO truncated \u005 and malformed \uZZZZ are literal text",
        r"INFO unmatched \ud800 and \udc00 are literal text",
        r"INFO emoji \ud83d\ude00 is ordinary text",
    ] {
        assert!(!sensitive_source(text), "safe source rejected: {text}");
    }
    for text in [
        r#"{"Output":"safe","Output":"\u0042earer synthetic-sentinel-only"}"#,
        r#"{"Output":"malformed \u0042earer synthetic-sentinel-only""#,
    ] {
        assert!(
            sensitive_source(text),
            "ambiguous escaped source accepted: {text}"
        );
    }
    let mut budget = 2;
    assert!(decoded_source_sensitive(
        r#"{"Output":"\u0073afe"}"#,
        0,
        &mut budget
    ));
    let mut budget = 100;
    assert!(decoded_source_sensitive(
        r#"{"Output":"\u0073afe"}"#,
        8,
        &mut budget
    ));
}

#[test]
fn credential_prefixes_do_not_match_ordinary_identifier_suffixes() {
    for text in [
        "INFO task-state refreshed",
        "INFO disk-cache hit",
        "INFO risk-check completed",
        "INFO ask-service responded",
        "INFO example_ghp_count=12",
        "process.env.RETRY_COUNT=3",
        "const settings = process.env;",
        "process.env['OPENAI_API_KEY']",
        "settings.environment=development",
    ] {
        assert!(!sensitive(text), "{text}");
        assert!(
            !sensitive_input(&json!({"tool_input":{"cmd":text}})),
            "serialized input: {text}"
        );
    }
}

#[test]
fn credential_and_environment_file_markers_stay_guarded() {
    for text in [
        "sk-synthetic-sentinel",
        "value: sk-synthetic-sentinel",
        "Bearer sk-synthetic-sentinel",
        r#"{"value":"ghp_synthetic_sentinel"}"#,
        "ghp_synthetic_sentinel",
        "cat .env",
        "cat .env.local",
        "cat /home/example/.env.production",
        r#"type C:\example\.env"#,
        "cat .envrc",
        "cat .env_vars",
        "cat .envproduction",
        "cat .environment",
        "cat config.env",
        "cat process.env",
        "cat process.env.local",
        "cat /home/example/process.env",
        r#"type C:\example\process.env"#,
        "password: synthetic-sentinel",
        "PASSWORD   = synthetic-sentinel",
        r#"{"password":"synthetic-sentinel"}"#,
        r#"{"api_key" : "synthetic-sentinel"}"#,
        r#"{"token":"synthetic-sentinel"}"#,
        "<password>synthetic-sentinel</password>",
        "Authorization : Basic synthetic-sentinel",
        "api key setup",
        "private key setup",
        "-----BEGIN PRIVATE KEY-----",
    ] {
        assert!(sensitive(text), "{text}");
        assert!(
            sensitive_input(&json!({"tool_input":{"cmd":text}})),
            "serialized input: {text}"
        );
    }
}

#[test]
fn environment_path_fields_keep_file_guards_even_for_identifier_spellings() {
    for field in ["path", "file_path", "filePath", "cwd", "workdir"] {
        for path in [
            ".env",
            ".env.local",
            ".env_vars",
            ".envproduction",
            ".environment",
            "process.env",
            "process.env.local",
            "settings.environment",
        ] {
            assert!(
                sensitive_input(&json!({"tool_input":{field:path}})),
                "{field}: {path}"
            );
        }
    }
    assert!(sensitive_input(
        &json!({"tool_input":{"paths":["safe.txt","process.env.local"]}})
    ));
    assert!(sensitive_input(
        &json!({"tool_input":{"path":{"value":"process.env.local"}}})
    ));
    assert!(sensitive_input(
        &json!({"tool_input":{"paths":[{"value":"settings.environment"}]}})
    ));
    assert!(!sensitive_input(
        &json!({"tool_input":{"cmd":"const env = process.env; settings.environment=development"}})
    ));
    assert!(!sensitive_input(
        &json!({"tool_input":{"cmd":"process.env['RETRY_COUNT']"}})
    ));
}

#[test]
fn identifier_reference_does_not_override_a_credential_value() {
    for text in [
        "process.env.password = synthetic-sentinel",
        "process.env.OPENAI_API_KEY=synthetic-sentinel",
        "process.env.CLIENT_SECRET=synthetic-sentinel",
        "process.env.TOKEN: synthetic-sentinel",
    ] {
        assert!(sensitive(text), "{text}");
    }
}

#[test]
fn precise_environment_member_reads_do_not_contain_credential_values() {
    for text in [
        "process.env.ACCESS_TOKEN",
        "process.env.CLIENT_SECRET",
        "process.env['ACCESS_TOKEN']",
        "process.env[\"CLIENT_SECRET\"]",
        "const value = process.env.ACCESS_TOKEN;",
        "console.log(process.env.CLIENT_SECRET);",
        "const values = [process.env.ACCESS_TOKEN, process.env['CLIENT_SECRET']];",
    ] {
        assert!(!sensitive(text), "{text}");
        assert!(
            !sensitive_input(&json!({"tool_input":{"cmd":text}})),
            "serialized input: {text}"
        );
    }
}

#[test]
fn environment_member_exemptions_never_hide_assignments_or_other_markers() {
    for text in [
        "process.env.ACCESS_TOKEN = synthetic-sentinel",
        "process.env.CLIENT_SECRET: synthetic-sentinel",
        "process.env['ACCESS_TOKEN'] = 'synthetic-sentinel'",
        "process.env[\"CLIENT_SECRET\"]: 'synthetic-sentinel'",
        "process.env.ACCESS_TOKEN === 'synthetic-sentinel'",
        "process.env.ACCESS_TOKEN synthetic-sentinel",
        "process.env.ACCESS_TOKEN_EXTRA",
        "cat /tmp/process.env.ACCESS_TOKEN",
        "cat process.env['CLIENT_SECRET']",
        "const value = process.env.ACCESS_TOKEN; password=synthetic-sentinel",
        "const value = process.env.CLIENT_SECRET; sk-synthetic-sentinel",
        "access_token",
        "client_secret",
        "api key setup",
        "api key synthetic-sentinel",
        "\u{200b}sk-synthetic-sentinel",
        "\u{2014}ghp_synthetic_sentinel",
    ] {
        assert!(sensitive(text), "{text}");
        assert!(
            sensitive_input(&json!({"tool_input":{"cmd":text}})),
            "serialized input: {text}"
        );
    }
    for field in [
        "password",
        "api_key",
        "access_token",
        "client_secret",
        "authorization",
    ] {
        for value in [json!("synthetic-sentinel"), json!(null), json!(1)] {
            assert!(
                sensitive_input(&json!({"tool_input":{field:value}})),
                "field: {field}"
            );
        }
    }
    assert!(sensitive_input(
        &json!({"tool_input":{"paths":["process.env.ACCESS_TOKEN"]}})
    ));
    assert!(sensitive_input(
        &json!({"tool_input":{"cmd":"process.env.CLIENT_SECRET", "options":{"password":"synthetic-sentinel"}}})
    ));
}
