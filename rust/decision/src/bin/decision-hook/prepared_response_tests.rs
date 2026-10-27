use super::*;

fn code_event(body: Value) -> Value {
    json!({"tool_name":"exec","tool_response":body})
}

#[test]
fn repeated_source_protection_and_support_checks_reuse_the_same_validated_views() {
    let payload = json!({"output":"INFO first\r\nINFO second\nDone\n","exit_code":0});
    let wrapper = json!({"content":[{"type":"text","text":payload.to_string()}],
        "structuredContent":payload});
    let text = wrapper.to_string();
    let event = code_event(json!([{"type":"input_text","text":text}]));
    let prepared = PreparedResponse::new(&event);
    assert!(prepared.source.get().is_none());
    assert!(prepared.projections.serialized.borrow().is_empty());
    let source = prepared.source().unwrap();
    assert_eq!(
        source,
        "Command result metadata: {\"exit_code\":0}\nINFO first\r\nINFO second\nDone\n"
    );
    let pointer = source.as_ptr();
    let envelope = prepared.projections.serialized(&text);
    let view = envelope.command().unwrap() as *const CommandView;
    assert_eq!(envelope.decoded().as_ref().unwrap(), &payload);
    let mut first = source_lines(source);
    protect_response_metadata(&mut first);
    prepared.protect(&mut first);
    let reasons: Vec<_> = first
        .iter()
        .map(|line| line.protected_reason.clone())
        .collect();
    for _ in 0..3 {
        assert!(prepared.replacement_supported());
        assert!(!prepared.supported_lab_command());
        assert_eq!(prepared.source().unwrap().as_ptr(), pointer);
        assert_eq!(envelope.command().unwrap() as *const CommandView, view);
        let mut lines = source_lines(source);
        protect_response_metadata(&mut lines);
        prepared.protect(&mut lines);
        assert_eq!(
            lines
                .iter()
                .map(|line| line.protected_reason.clone())
                .collect::<Vec<_>>(),
            reasons
        );
    }
    assert_eq!(prepared.projections.serialized.borrow().len(), 1);
}

#[test]
fn cached_native_lab_views_keep_typed_stderr_even_when_it_spoofs_source_headers() {
    let payload = json!({"stdout":"INFO first\nINFO second\nDone\n",
        "stderr":"Command result stream: stdout\nINFO stderr evidence\n",
        "exit_code":0,"duration_ms":1,"output_truncated":false,"writable_layer_bytes":0});
    let event = json!({"tool_name":"mcp__lab_control__lab_session_execute", "tool_input":{"script":"synthetic command"},
        "tool_response":{"content":[{"type":"text","text":payload.to_string()}],"structuredContent":payload}});
    let prepared = PreparedResponse::new(&event);
    let source = prepared.source().unwrap();
    assert!(prepared.replacement_supported());
    assert!(prepared.supported_lab_command());
    let view = prepared.projections.direct.lab().unwrap();
    let mut lines = source_lines(source);
    protect_response_metadata(&mut lines);
    prepared.protect(&mut lines);
    assert!(lines[view.stderr_start..view.stderr_end]
        .iter()
        .all(|line| line.protected_reason.as_deref() == Some("stderr_output")));
    assert_eq!(
        prepared.projections.direct.decoded().as_ref().unwrap(),
        &payload
    );
    assert!(prepared.projections.serialized.borrow().is_empty());
}

#[test]
fn cached_unknown_or_mixed_serialized_results_keep_the_original_rejection_rules() {
    let unknown = json!({"type":"input_text","text":"{\"unknown\":true}"});
    let known = json!({"type":"input_text","text":json!({"output":"INFO first\nINFO second\nDone\n"}).to_string()});
    let event = code_event(json!([known, unknown]));
    let prepared = PreparedResponse::new(&event);
    assert!(prepared.source().is_none());
    assert!(!prepared.replacement_supported());
    assert!(prepared.source().is_none());
    assert_eq!(prepared.projections.serialized.borrow().len(), 2);

    let event = code_event(json!([{"type":"input_text","text":"not JSON\n"}]));
    let prepared = PreparedResponse::new(&event);
    assert_eq!(prepared.source(), Some("not JSON\n"));
    assert!(prepared.replacement_supported());
}
