use codex_decision::provider::{encode_request, wire_request};
use serde_json::{json, Value};

fn compare(request: &Value) {
    let before = serde_json::to_vec(request).unwrap();
    assert_eq!(
        encode_request(request),
        wire_request(request).map(|wire| serde_json::to_vec(&wire).unwrap())
    );
    assert_eq!(before, serde_json::to_vec(request).unwrap());
}

#[test]
fn borrowed_wire_encoding_matches_the_existing_complete_bytes() {
    let values = [
        Value::Null,
        json!(true),
        json!(-0.0),
        json!(u64::MAX),
        json!("λ🌍\"\\\r\n\t\u{0}"),
        json!([null, false, {"nested":[1,2,3]}]),
        json!({"true":"required λ🌍","false":"routine\n\"\\","unknown":42}),
    ];
    for seed in 0..500 {
        let mut questions = serde_json::Map::new();
        for number in 0..seed % 101 {
            let mut question = json!({"instructions":format!("Is line {number} required? λ🌍\"\\\t\n"),
                "type":if number % 3 == 0 { "choice" } else { "noul" }});
            if number % 3 == 0 {
                question["criteria"] = json!({"α":"説明","b":null,"c":42,"d":"\u{0}\r\n"});
            } else if number % 4 != 0 {
                question["criteria"] = values[(seed + number) % values.len()].clone();
            }
            questions.insert(format!("line_{number}"), question);
        }
        for model in ["gpt-6-luna", "jev-latest"] {
            compare(&json!({"model":model,"state":values[seed % values.len()],
                "questions":questions,"extra":{"preserved":"for TypeSafe"}}));
        }
    }
    compare(&json!({"model":"gpt-6-luna","questions":{}}));
}

#[test]
fn borrowed_wire_encoding_preserves_validation_errors() {
    for request in [
        json!({}),
        json!({"model":null}),
        json!({"model":"unsupported"}),
        json!({"model":"gpt-6-luna"}),
        json!({"model":"gpt-6-luna","questions":[]}),
        json!({"model":"gpt-6-luna","questions":{"q":null}}),
        json!({"model":"gpt-6-luna","questions":{"q":{"instructions":42,"type":"noul"}}}),
        json!({"model":"gpt-6-luna","questions":{"q":{"instructions":"text","type":"other"}}}),
        json!({"model":"gpt-6-luna","questions":{"q":{"instructions":"text","type":"choice"}}}),
        json!({"model":"gpt-6-luna","questions":{"q":{"instructions":"text","type":"choice","criteria":[]}}}),
        json!({"model":"jev-latest","questions":null,"state":["unmodified"]}),
    ] {
        compare(&request);
    }
}
