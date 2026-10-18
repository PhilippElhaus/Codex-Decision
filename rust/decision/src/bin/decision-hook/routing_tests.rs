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

#[test]
fn reviewed_mcp_read_actions_do_not_match_mutation_resource_names() {
    for prefix in ["mcp__synthetic__", "functions.mcp__synthetic__"] {
        for (action, format) in [
            ("list_commits", "search_listing"),
            ("get_deployment_status", "output"),
            ("lookup_merge_conflicts", "search_listing"),
        ] {
            let tool = format!("{prefix}{action}");
            assert_eq!(tool_route(&tool), Some(format), "{tool}");
            let event = json!({"tool_name":tool,"tool_input":{"query":"synthetic"}});
            assert_eq!(output_format(&event), Some(format));
            // Recognition grants evaluation only. The user's MCP replacement
            // setting must independently authorize a changed tool result.
            assert!(mcp_tool(event["tool_name"].as_str().unwrap()));
        }
        for action in [
            "commit",
            "deploy",
            "merge",
            "list_commits_and_push",
            "get_deployment_status_and_delete",
            "lookup_merge_conflicts_and_merge",
            "list_commits_credentials",
            "get_deployment_status_secret",
            "lookup_merge_conflicts_token",
            "list_commits_api_key",
        ] {
            let tool = format!("{prefix}{action}");
            assert_eq!(tool_route(&tool), None, "{tool}");
        }
    }
    for tool in [
        "list_commits",
        "functions.get_deployment_status",
        "lookup_merge_conflicts",
    ] {
        assert_eq!(tool_route(tool), None, "{tool}");
    }
}
