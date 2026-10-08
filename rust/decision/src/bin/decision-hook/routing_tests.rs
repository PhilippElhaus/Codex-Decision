use super::*;

#[test]
fn empty_stdin_polls_are_supported_and_actual_input_writes_remain_unsupported() {
    for tool in ["write_stdin", "functions.write_stdin"] {
        for input in [
            json!({"session_id":12}),
            json!({"session_id":12,"chars":""}),
        ] {
            let event = json!({"tool_name":tool,"tool_input":input,"tool_response":{"output":"INFO poll\n","session_id":12}});
            assert!(polling_tool(&event));
            assert_eq!(output_format(&event), Some("output"));
            assert!(replacement_supported(&event));
        }
        for chars in [json!("x"), json!("\n"), json!(null), json!(17)] {
            let event = json!({"tool_name":tool,"tool_input":{"chars":chars}});
            assert!(!polling_tool(&event));
            assert_eq!(output_format(&event), None);
        }
    }
}

#[test]
fn dotted_namespaces_preserve_mutation_and_exact_file_guards() {
    for tool in [
        "functions.write_file",
        "functions.send_message",
        "functions.delete_file",
    ] {
        assert_eq!(tool_route(tool), None, "{tool}");
    }
    for tool in [
        "functions.read_file",
        "functions.Read",
        "functions.read_text_file",
    ] {
        let event = json!({"tool_name":tool,"tool_input":{"path":"Config"}});
        let mut lines = source_lines(&("INFO configuration value\n".repeat(30) + "Done\n"));
        assert!(
            matches!(
                format_decision(&event, &mut lines),
                FormatDecision::Keep("exact_content")
            ),
            "{tool}"
        );
    }
}
