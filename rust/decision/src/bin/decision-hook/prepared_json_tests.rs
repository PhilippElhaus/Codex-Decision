use super::*;

#[test]
fn timestamp_insertion_matches_the_real_encoder_and_ignores_nested_decoys() {
    for length in [0, 1, 64, 1000, 10000] {
        let mut value = json!({"at":"old", "before":{"at":"nested"},
            "rows":[{"at":"unchanged","text":"\"at\":\"\" λ🌍\\\n".repeat(length)}],
            "z":{"at":"after"}});
        for timestamp in [
            "2026-10-07T10:03:20+00:00",
            "2026-10-07T10:03:20.123456789+00:00",
            "\"\\\n状态🌍",
        ] {
            let prepared = prepare_snapshot(&value).unwrap();
            value["at"] = json!(timestamp);
            assert_eq!(
                prepared.finish(timestamp).unwrap(),
                serde_json::to_vec(&value).unwrap()
            );
        }
    }
}

#[test]
fn receipt_stamps_only_its_manifest_and_preserves_every_other_value() {
    let source = "\"at\":\"\" λ🌍\r\n";
    let event = json!({"tool_name":"Bash","tool_input":{"at":"input decoy","nested":{"at":""}}});
    let mut manifest = json!({"at":"old","nested":{"at":"manifest decoy"},"api_usage":{"input_tokens":3,"output_tokens":0}});
    for visible in [None, Some(source)] {
        let prepared = prepare_receipt(&manifest, &event, source, visible, &[]).unwrap();
        let timestamp = "2026-10-07T10:03:20.123456789+00:00";
        manifest["at"] = json!(timestamp);
        assert_eq!(
            prepared.finish(timestamp).unwrap(),
            encode_receipt(&manifest, &event, source, visible, &[]).unwrap()
        );
    }
}

#[test]
fn final_timestamp_growth_obeys_exact_size_bounds_and_missing_markers_fail() {
    let value = json!({"at":"old","text":"λ🌍\"\\\n"});
    let timestamp = "2026-10-07T10:03:20.123456789+00:00";
    let mut stamped = value.clone();
    stamped["at"] = json!(timestamp);
    let expected = serde_json::to_vec(&stamped).unwrap();
    for limit in [expected.len() - 1, expected.len(), expected.len() + 1] {
        let marker = TimestampMarker::default();
        let wrapper = TimestampMap::new(&value, &marker).unwrap();
        let bytes = super::super::encoding::encode_marked(
            &wrapper,
            limit,
            "encoding",
            "oversized",
            &marker.offset,
        )
        .unwrap();
        let result = PreparedJson::new(bytes, &marker, limit, "oversized")
            .unwrap()
            .finish(timestamp);
        if limit < expected.len() {
            assert_eq!(result.unwrap_err(), "oversized");
        } else {
            assert_eq!(result.unwrap(), expected);
        }
    }
    for bad in [
        Value::Null,
        json!({}),
        json!({"at":null}),
        json!({"at":123}),
    ] {
        assert!(prepare_snapshot(&bad).is_err());
    }
    assert!(PreparedJson::new(vec![], &TimestampMarker::default(), 16, "oversized").is_err());
    let wrong = TimestampMarker::default();
    wrong.range.set(Some((0, 2)));
    assert!(PreparedJson::new(b"{}".to_vec(), &wrong, 16, "oversized").is_err());
}
