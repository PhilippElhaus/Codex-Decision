use codex_decision::provider::normalize_response;
use serde_json::{json, Value};

#[path = "provider_responses/baseline.rs"]
mod baseline;

fn compare(request: &Value, response: Value) {
    let actual = normalize_response(request, response.clone());
    let expected = baseline::normalize_response(request, response);
    assert_eq!(actual, expected);
    if let (Ok(actual), Ok(expected)) = (actual, expected) {
        assert_eq!(
            serde_json::to_vec(&actual).unwrap(),
            serde_json::to_vec(&expected).unwrap()
        );
    }
}

#[test]
fn owned_answers_preserve_every_normalized_value_and_envelope_field() {
    for count in [0, 1, 2, 10, 90, 1000] {
        let mut questions = serde_json::Map::new();
        for number in 0..count {
            questions.insert(format!("line_{number}🌍"), json!({"type":"noul"}));
        }
        let answers: Vec<_> = questions
            .keys()
            .enumerate()
            .map(|(n, name)| {
                json!({"name":name,
            "type":"predicate","probability":match n%5 {0=>0.0,1=>-0.0,2=>0.05,3=>1.0,_=>0.05001}})
            })
            .collect();
        let request = json!({"model":"gpt-6-luna","questions":questions});
        for usage in [
            None,
            Some(
                json!({"input_tokens":123,"output_tokens":0,"total_tokens":123,
            "input_tokens_details":{"cached_tokens":10,"cache_write_tokens":2},
            "output_tokens_details":{"reasoning_tokens":0}}),
            ),
        ] {
            let mut response = json!({"model":"gpt-6-luna","answers":answers});
            if let Some(usage) = usage {
                response["usage"] = usage;
            }
            compare(&request, response);
        }
    }
}

#[test]
fn malformed_predicates_keep_the_same_fail_open_validation() {
    let request = json!({"model":"gpt-6-luna","questions":{"q":{"type":"noul"}}});
    let valid = json!({"model":"gpt-6-luna","answers":[{"name":"q","type":"predicate","probability":0.01}]});
    for (path, values) in [
        (
            "/model",
            vec![Value::Null, json!("jev-latest"), json!("unsupported")],
        ),
        (
            "/answers",
            vec![Value::Null, json!({}), json!([]), json!([{}, {}])],
        ),
        (
            "/answers/0/name",
            vec![Value::Null, json!(false), json!("other")],
        ),
        (
            "/answers/0/type",
            vec![Value::Null, json!("refusal"), json!("choice")],
        ),
        (
            "/answers/0/probability",
            vec![Value::Null, json!(-1), json!(1.1), json!("0.01"), json!({})],
        ),
    ] {
        for value in values {
            let mut response = valid.clone();
            *response.pointer_mut(path).unwrap() = value;
            compare(&request, response);
        }
    }
    for key in ["name", "type", "probability"] {
        let mut response = valid.clone();
        response["answers"][0].as_object_mut().unwrap().remove(key);
        compare(&request, response.clone());
        response["answers"][0]["unexpected"] = Value::Null;
        compare(&request, response);
    }
    let mut response = valid.clone();
    response["unexpected"] = Value::Null;
    compare(&request, response);
    let mut response = valid;
    response["answers"][0]["confidence"] = json!(0.99);
    compare(&request, response);
}

#[test]
fn choice_rows_keep_names_types_duplicates_and_probability_validation() {
    let request = json!({"model":"gpt-6-luna","questions":{"output_kind":{"type":"choice"}}});
    let valid = json!({"model":"gpt-6-luna","answers":[{"name":"output_kind","type":"choice",
        "choice":"progress_output","confidence":0.9,"probabilities":[{"value":"progress_output","probability":0.9},{"value":"prose","probability":0.1}]}]});
    compare(&request, valid.clone());
    for (path, values) in [
        (
            "/answers/0/choice",
            vec![Value::Null, json!(true), json!(3)],
        ),
        (
            "/answers/0/confidence",
            vec![Value::Null, json!(-1), json!(1.1)],
        ),
        (
            "/answers/0/probabilities",
            vec![Value::Null, json!({}), json!([]), json!([{}, {}])],
        ),
        (
            "/answers/0/probabilities/0",
            vec![
                json!({"value":"x","unexpected":null}),
                json!({"value":true,"probability":0.1}),
                json!({"value":"x"}),
                json!(0.1),
            ],
        ),
        (
            "/answers/0/probabilities/0/value",
            vec![json!("prose"), json!(false), Value::Null],
        ),
        (
            "/answers/0/probabilities/0/probability",
            vec![Value::Null, json!(-1), json!(1.1)],
        ),
    ] {
        for value in values {
            let mut response = valid.clone();
            *response.pointer_mut(path).unwrap() = value;
            compare(&request, response);
        }
    }
    for key in ["name", "type", "choice", "confidence", "probabilities"] {
        let mut response = valid.clone();
        response["answers"][0].as_object_mut().unwrap().remove(key);
        compare(&request, response.clone());
        response["answers"][0]["unexpected"] = Value::Null;
        compare(&request, response);
    }
}
