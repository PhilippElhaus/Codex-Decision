use super::*;
use serde_json::json;

// Frozen 4b24210 projection. Compare complete bytes, including metadata order.
pub(crate) fn baseline(object: &Map<String, Value>) -> String {
    let metadata = object
        .iter()
        .filter(|(key, _)| key.as_str() != "output")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    format!(
        "Command result metadata: {}\n{}",
        Value::Object(metadata),
        object["output"].as_str().unwrap()
    )
}

#[test]
fn command_projection_preserves_complete_baseline_bytes() {
    let text = [
        "",
        "λ🌍\r\n",
        "\"\\\t\u{0}",
        "INFO poll\nDone",
        "{\"output\":\"decoy\"}",
    ];
    for mask in 0..32 {
        for output in text {
            for exit_code in [Value::Null, json!(i64::MIN), json!(0)] {
                let mut object = Map::from_iter([("output".into(), json!(output))]);
                for (bit, name, value) in [
                    (0, "chunk_id", json!(text[mask % text.len()])),
                    (1, "exit_code", exit_code),
                    (2, "wall_time_seconds", json!(-0.0)),
                    (3, "session_id", json!(u64::MAX)),
                    (4, "original_token_count", json!(u64::MAX)),
                ] {
                    if mask & (1 << bit) != 0 {
                        object.insert(name.into(), value);
                    }
                }
                assert_eq!(command_projection(&object), baseline(&object));
            }
        }
    }
    for (stdout, chunk) in [(2_000_000, 16), (16, 500_000)] {
        let value = json!({"output":"λ🌍\r\n".repeat(stdout / 8),
            "chunk_id":"\"\\λ".repeat(chunk / 4),"exit_code":null});
        assert_eq!(
            command_projection(value.as_object().unwrap()),
            baseline(value.as_object().unwrap())
        );
    }
}
