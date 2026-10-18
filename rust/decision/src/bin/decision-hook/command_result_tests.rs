use super::*;

fn payload(output: &str) -> Value {
    json!({"output":output,"chunk_id":"synthetic","exit_code":1,
        "wall_time_seconds":0.01,"session_id":123,"original_token_count":900})
}

fn duplicate(value: &Value) -> Value {
    json!({"content":[{"type":"text","text":value.to_string()}],
        "structuredContent":value,"isError":false})
}

fn code_event(value: &Value) -> Value {
    json!({"tool_name":"functions.exec","tool_response":[
        {"type":"input_text","text":value.to_string()}]})
}

#[test]
fn exact_duplicated_command_envelopes_keep_every_command_metadata_field() {
    let value = payload("INFO first\r\nERROR synthetic refusal\nDone");
    let expected = command_projection(value.as_object().unwrap());
    for tool in [
        "exec_command",
        "functions.exec_command",
        "exec",
        "functions.wait",
    ] {
        let event = json!({"tool_name":tool,"tool_input":{"session_id":123},
            "tool_response":duplicate(&value)});
        assert_eq!(response_text(&event).as_deref(), Some(expected.as_str()));
        assert!(replacement_supported(&event));
    }
    let code = code_event(&duplicate(&value));
    assert_eq!(response_text(&code).as_deref(), Some(expected.as_str()));
    assert!(replacement_supported(&code));
}

#[test]
fn duplicate_command_wrappers_reject_unknown_mismatched_and_mixed_media_fields() {
    let value = payload("INFO required evidence\nDone");
    let mut invalid = Vec::new();
    for (pointer, replacement) in [
        ("/isError", json!(true)),
        ("/isError", json!("false")),
        ("/structuredContent/output", json!("different evidence")),
        ("/structuredContent/exit_code", json!(0)),
        ("/content/0/type", json!("image")),
        (
            "/content/0/text",
            json!(r#"{"output":"first","output":"second"}"#),
        ),
    ] {
        let mut wrapper = duplicate(&value);
        *wrapper.pointer_mut(pointer).unwrap() = replacement;
        invalid.push(wrapper);
    }
    let mut unknown = duplicate(&value);
    unknown["unknown"] = json!(true);
    invalid.push(unknown);
    let mut mixed = duplicate(&value);
    mixed["content"]
        .as_array_mut()
        .unwrap()
        .push(json!({"type":"image","data":"synthetic"}));
    invalid.push(mixed);
    let mut annotated = duplicate(&value);
    annotated["content"][0]["annotations"] = json!({"priority":1});
    invalid.push(annotated);
    let mut missing = duplicate(&value);
    missing.as_object_mut().unwrap().remove("structuredContent");
    // A legacy text-only envelope can be inspected as raw text, but it never
    // acquires the replacement permission of a validated command envelope.
    assert!(!replacement_supported(
        &json!({"tool_name":"exec_command","tool_response":missing})
    ));
    for wrapper in invalid {
        let event = json!({"tool_name":"exec_command","tool_response":wrapper});
        assert!(response_text(&event).is_none(), "{event}");
        assert!(!replacement_supported(&event));
    }
}

#[test]
fn serialized_command_and_all_settled_batches_preserve_status_order_and_boundaries() {
    let first = payload("INFO first\nINFO routine one\nINFO routine three\nDone");
    let second = payload("INFO second\r\nINFO routine two\r\nINFO routine four\r\nDone\r\n");
    let batches = [
        json!([first, second]),
        json!([{"status":"fulfilled","value":first},{"status":"fulfilled","value":second}]),
        json!([{"i":0,"status":"fulfilled","value":duplicate(&first)},
            {"i":1,"status":"fulfilled","value":second}]),
    ];
    for batch in batches {
        let event = code_event(&batch);
        assert!(replacement_supported(&event));
        let source = response_text(&event).unwrap();
        assert!(source.contains("\"batch_size\":2"));
        assert!(source.contains("\"batch_index\":0"));
        assert!(source.contains("\"batch_index\":1"));
        assert_eq!(source.matches("\"session_id\":123").count(), 2);
        assert_eq!(source.matches("\"original_token_count\":900").count(), 2);
        assert!(source.contains(first["output"].as_str().unwrap()));
        assert!(source.contains(second["output"].as_str().unwrap()));
        if batch[0].get("status").is_some() {
            assert_eq!(source.matches("\"status\":\"fulfilled\"").count(), 2);
        }
        let mut lines = source_lines(&source);
        protect_response_metadata(&mut lines);
        protect_command_boundaries(&event, &mut lines);
        for index in [3, 6, 9, 12] {
            assert_eq!(
                lines[index].protected_reason.as_deref(),
                Some("stream_boundary"),
                "boundary line {} in {source}",
                index + 1
            );
        }
        for index in [4, 5, 10, 11] {
            assert!(
                lines[index].protected_reason.is_none(),
                "routine line {}",
                index + 1
            );
        }
        for index in [0, 1, 2, 7, 8] {
            assert_eq!(
                lines[index].protected_reason.as_deref(),
                Some("tool_metadata")
            );
        }
    }
}

#[test]
fn long_independent_logs_in_a_batch_keep_the_direct_format_contract() {
    let output = "INFO synthetic routine heartbeat\n".repeat(30) + "Done";
    let event = code_event(&json!([payload(&output), payload(&output)]));
    let source = response_text(&event).unwrap();
    let mut lines = source_lines(&source);
    protect_response_metadata(&mut lines);
    protect_command_boundaries(&event, &mut lines);
    assert!(matches!(
        format_decision(&event, &mut lines),
        FormatDecision::Direct("repetitive_log")
    ));
}

#[test]
fn every_batch_member_requires_its_own_independent_format_contract() {
    let log = "INFO synthetic heartbeat\n".repeat(40) + "Done";
    let structured =
        serde_json::to_string_pretty(&json!({"required":(0..20).collect::<Vec<_>>()})).unwrap();
    let prose = "This paragraph depends on the preceding explanation.\n".repeat(20);
    for unsafe_output in [&structured, &prose] {
        let mut own_lines = source_lines(unsafe_output);
        assert!(!matches!(
            format_decision(&json!({"tool_name":"exec"}), &mut own_lines),
            FormatDecision::Direct(_)
        ));
        for outputs in [
            [log.as_str(), unsafe_output.as_str()],
            [unsafe_output.as_str(), log.as_str()],
        ] {
            let batch = json!([payload(outputs[0]), payload(outputs[1])]);
            assert!(command_view(&batch).is_none());
            let event = code_event(&batch);
            assert!(!replacement_supported(&event));
            assert_eq!(response_text(&event).unwrap(), batch.to_string());
        }
    }
    // A sparse context line stays protected even when the combined batch has
    // more unfamiliar context rows than the per-output sparse-context limit.
    let sparse = "INFO synthetic heartbeat\n".repeat(40) + "observed code=73\nDone";
    let batch = json!(vec![payload(&sparse); 12]);
    let event = code_event(&batch);
    let source = response_text(&event).unwrap();
    let mut lines = source_lines(&source);
    protect_response_metadata(&mut lines);
    protect_command_boundaries(&event, &mut lines);
    let context = lines
        .iter()
        .filter(|line| line.model_text == "observed code=73")
        .collect::<Vec<_>>();
    assert_eq!(context.len(), 12);
    assert!(context
        .iter()
        .all(|line| line.protected_reason.as_deref() == Some("unrecognized_log_context")));
}

#[test]
fn separate_fulfilled_code_mode_records_preserve_indexes_and_typed_boundaries() {
    let output = "INFO first\nINFO routine one\nINFO routine two\nDone";
    let parts = [0, 1].map(|i| json!({"i":i,"status":"fulfilled","value":payload(output)}));
    let event = json!({"tool_name":"exec","tool_response":parts.each_ref().map(|value|json!({"type":"input_text","text":value.to_string()}))});
    assert!(replacement_supported(&event));
    let source = response_text(&event).unwrap();
    assert!(source.contains("\"status\":\"fulfilled\",\"i\":0"));
    assert!(source.contains("\"status\":\"fulfilled\",\"i\":1"));
    let mut lines = source_lines(&source);
    protect_response_metadata(&mut lines);
    protect_command_boundaries(&event, &mut lines);
    for line in lines
        .iter()
        .filter(|line| matches!(line.model_text.as_str(), "INFO first" | "Done"))
    {
        assert_eq!(line.protected_reason.as_deref(), Some("stream_boundary"));
    }
    for value in [
        json!({"i":-1,"status":"fulfilled","value":payload(output)}),
        json!({"i":1,"status":"rejected","reason":"required failure"}),
        json!({"i":1,"status":"fulfilled","value":payload(output),"extra":"required"}),
        json!({"i":1,"status":"fulfilled","value":payload("{\n\"required\":73\n}")}),
    ] {
        let event = code_event(&value);
        assert!(!replacement_supported(&event));
        assert_eq!(response_text(&event).unwrap(), value.to_string());
        let mixed = json!({"tool_name":"exec","tool_response":[
            {"type":"input_text","text":parts[0].to_string()},
            {"type":"input_text","text":value.to_string()}]});
        assert!(response_text(&mixed).is_none());
        assert!(!replacement_supported(&mixed));
    }
}

#[test]
fn one_unknown_or_rejected_batch_item_rejects_the_entire_projection() {
    let known = payload("INFO routine one\nINFO routine two\nINFO routine three\nDone");
    for invalid in [
        json!([]),
        json!([known,{"output":"required evidence","stderr":"required stderr"}]),
        json!([known,{"content":[{"type":"image","data":"synthetic"}]}]),
        json!([known,{"status":"fulfilled","value":known}]),
        json!([{"status":"fulfilled","value":known},{"status":"rejected","reason":"required failure"}]),
        json!([{"i":1,"status":"fulfilled","value":known}]),
        json!([{"i":-1,"status":"fulfilled","value":known}]),
        json!([{"status":"fulfilled","value":known,"extra":"required evidence"}]),
        json!(vec![known.clone(); MAX_BATCH_ITEMS + 1]),
    ] {
        assert!(command_view(&invalid).is_none(), "{invalid}");
        let event = code_event(&invalid);
        assert!(!replacement_supported(&event), "{invalid}");
        assert_eq!(response_text(&event).unwrap(), invalid.to_string());
    }
    for raw in [
        r#"[{"output":"required","output":"routine"}]"#,
        r#"[{"status":"fulfilled","value":{"output":"required"},"value":{"output":"routine"}}]"#,
    ] {
        let event = json!({"tool_name":"exec","tool_response":[{"type":"input_text","text":raw}]});
        assert!(!replacement_supported(&event));
        assert_eq!(response_text(&event).as_deref(), Some(raw));
    }
    let oversized = json!([payload(&"INFO synthetic\n".repeat(MAX_PROJECTION / 10))]);
    assert!(command_view(&oversized).is_none());
}

#[test]
fn batch_boundary_offsets_follow_actual_code_mode_block_joins() {
    for prefix in ["Script completed", "Script completed\n", ""] {
        let batch = json!([
            payload("INFO first\nINFO routine\nINFO more\nDone\n"),
            payload("INFO next\nINFO routine\nINFO more\nDone")
        ]);
        let event = json!({"tool_name":"exec","tool_response":[
            {"type":"input_text","text":prefix},
            {"type":"input_text","text":batch.to_string()}]});
        let source = response_text(&event).unwrap();
        let mut lines = source_lines(&source);
        protect_response_metadata(&mut lines);
        protect_command_boundaries(&event, &mut lines);
        for line in lines.iter().filter(|line| {
            matches!(
                line.model_text.as_str(),
                "INFO first" | "INFO next" | "Done"
            )
        }) {
            assert_eq!(
                line.protected_reason.as_deref(),
                Some("stream_boundary"),
                "{source}"
            );
        }
    }
}

#[test]
fn command_batch_originals_save_the_complete_typed_transport_and_roll_back_together() {
    let output =
        "INFO routine one\nINFO routine two\nINFO routine three\nERROR required evidence\nDone";
    let batch = json!([{"i":0,"status":"fulfilled","value":payload(output)},
        {"i":1,"status":"fulfilled","value":duplicate(&payload(output))}]);
    let event = code_event(&batch);
    let source = response_text(&event).unwrap();
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("synthetic-original.txt");
    let typed = path.with_extension("json");
    {
        let _saved = SavedOriginals::save(&path, &source, &event["tool_response"]).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), source);
        let original: Value = serde_json::from_slice(&fs::read(&typed).unwrap()).unwrap();
        assert_eq!(original, event["tool_response"]);
        let decoded: Value =
            strict_json::parse(original[0]["text"].as_str().unwrap().as_bytes()).unwrap();
        assert_eq!(decoded, batch);
    }
    assert!(!path.exists());
    assert!(!typed.exists());
}
