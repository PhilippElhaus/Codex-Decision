use super::*;

#[test]
fn borrowed_receipts_preserve_exact_canonical_bytes_for_all_decision_fields() {
    let source = "状态🌍\r\n\"quoted\" \\value\t\x1b[31merror\x1b[0m\n";
    let event = json!({"tool_name":"Bash","tool_input":{"command":"printf λ"}});
    let manifest =
        json!({"version":3,"id":"synthetic","api_usage":{"input_tokens":7,"output_tokens":0}});
    let mut decisions = Vec::new();
    for number in 0..256 {
        decisions.push(codex_decision::LineDecision {
            number,
            action: match number % 3 {
                0 => Action::Omit,
                1 => Action::Keep,
                _ => Action::KeepUnjudged,
            },
            batch_id: (number & 1 != 0).then_some(number),
            p_can_omit: (number & 2 != 0).then_some(-0.0),
            p_exact_needed: (number & 4 != 0).then_some(0.05),
            p_task_relevant: (number & 8 != 0).then_some(0.05001),
            protected_reason: (number & 16 != 0).then_some("diagnostic λ".into()),
            reason: "required \"value\" 🌍".into(),
        });
    }
    for event in [&event, &json!({})] {
        for visible in [None, Some(source)] {
            let expected = serde_json::to_vec(&json!({"version":3,"manifest":manifest,
                "tool":event.get("tool_name"),"tool_input":event.get("tool_input"),
                "initial_output":source,"visible_output":visible,"decisions":decisions}))
            .unwrap();
            assert_eq!(
                encode_receipt(&manifest, event, source, visible, &decisions).unwrap(),
                expected
            );
        }
    }
}

#[test]
fn borrowed_batches_preserve_wire_evidence_and_optional_usage_bytes() {
    for id in [0, 1, 99] {
        let batch = BatchRecord {
            id,
            target_numbers: vec![1, 2, 99],
            elapsed_ms: 123,
            request: json!({"model":"gpt-6-luna","state":{"task":"λ","lines":["\"\\\n"]}}),
            response: json!({"model":"gpt-6-luna","answers":{"line_2":{"type":"noul","noul":0.05001}},
                "usage":{"input_tokens":5,"output_tokens":0,"cached_tokens":2}}),
        };
        let expected =
            serde_json::to_vec(&json!({"version":2,"receipt_id":"synthetic","batch":batch}))
                .unwrap();
        assert_eq!(encode_batch("synthetic", &batch).unwrap(), expected);
    }
}

#[test]
fn encoded_limits_are_exact_and_stop_before_oversized_records_finish() {
    let value = json!({"text":"状态🌍\"\\\n"});
    let expected = serde_json::to_vec(&value).unwrap();
    assert_eq!(
        encode(&value, expected.len(), "encoding", "oversized").unwrap(),
        expected
    );
    assert_eq!(
        encode(&value, expected.len() - 1, "encoding", "oversized").unwrap_err(),
        "oversized"
    );
    let mut writer = BoundedRecord {
        bytes: Vec::new(),
        limit: 16,
        overflow: false,
        offset: None,
    };
    writer.write_all(b"known bytes").unwrap();
    assert!(writer.write_all(&[0; 100]).is_err());
    assert_eq!(writer.bytes, b"known bytes");
    assert!(writer.overflow);
    assert!(writer.bytes.capacity() <= writer.limit);
    let source = "\0".repeat(MAX_RECEIPT_BYTES / 6 + 1);
    assert_eq!(
        encode_receipt(&json!({}), &json!({}), &source, None, &[]).unwrap_err(),
        "receipt too large"
    );
}

#[test]
fn irregular_large_chunks_cannot_grow_the_buffer_past_its_byte_limit() {
    let mut writer = BoundedRecord {
        bytes: Vec::with_capacity(3),
        limit: 37,
        overflow: false,
        offset: None,
    };
    for count in [12, 19, 6] {
        writer.write_all(&vec![b'x'; count]).unwrap();
        assert!(writer.bytes.capacity() <= 37);
    }
    assert_eq!(writer.bytes.len(), 37);
    assert!(writer.write_all(b"x").is_err());
    assert_eq!(writer.bytes.len(), 37);
}
