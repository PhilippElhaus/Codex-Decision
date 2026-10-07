use codex_decision::{provider::wire_request, semantic::*};
use serde_json::{json, Value};

fn compare(request: &Value) {
    let wire = wire_request(request).unwrap();
    let questions = wire["questions"].as_array().unwrap();
    let longest = questions
        .iter()
        .map(|q| serde_json::to_vec(q).unwrap().len())
        .max()
        .unwrap();
    let budget = request_budget(request).unwrap();
    assert_eq!(
        budget.state_longest_question_bound,
        serde_json::to_vec(&wire["input"]).unwrap().len() + longest + TOKEN_HEADROOM
    );
    assert_eq!(
        budget.whole_request_bound,
        serde_json::to_vec(&wire).unwrap().len() + TOKEN_HEADROOM
    );
}

#[test]
fn openai_budgets_match_the_actual_encoder_for_nested_values_and_every_escape() {
    let controls: String = (0..=31).map(char::from).collect();
    let texts = [
        controls.as_str(),
        "\"\\\n\tλ状态🌍",
        "",
        "ASCII text",
        "/path?x=1&y=2",
    ];
    let mut state = 0x647eab31u32;
    for index in 0..500 {
        state = state.wrapping_mul(1664525).wrapping_add(1013904223);
        let text = texts[state as usize % texts.len()].repeat((state as usize % 7) + 1);
        let nested = json!({"text":text,"values":[null,true,false,u64::MAX,i64::MIN,1e-20,1e20],
            "nested":{"\"λ\\":[text, {"x":index}]}});
        let input = match index % 5 {
            0 => nested.clone(),
            1 => json!([nested, text]),
            2 => json!(text),
            3 => Value::Null,
            _ => json!(index),
        };
        let mut questions = serde_json::Map::new();
        for number in 0..1 + index % 13 {
            let question = if number % 3 == 0 {
                json!({"type":"choice","instructions":text,"criteria":{
                    "\"yes🌍":text,"false":null,"unknown":nested}})
            } else if number % 3 == 1 {
                json!({"type":"noul","instructions":text,"criteria":nested})
            } else {
                json!({"type":"noul","instructions":text})
            };
            questions.insert(format!("q{number}\"\\🌍"), question);
        }
        compare(&json!({"model":"gpt-6-luna","state":input,"questions":questions}));
    }
}

#[test]
fn openai_both_budget_boundaries_remain_exact() {
    let mut request = json!({"model":"gpt-6-luna","state":"", "questions":{
        "q":{"type":"noul","instructions":"needed?"}}});
    let empty = request_budget(&request).unwrap();
    let length = DECISION_STATE_QUESTION_TOKENS - empty.state_longest_question_bound;
    request["state"] = json!("x".repeat(length));
    compare(&request);
    assert_eq!(
        validate_request_budget(&request)
            .unwrap()
            .state_longest_question_bound,
        DECISION_STATE_QUESTION_TOKENS
    );
    request["state"] = json!("x".repeat(length + 1));
    assert!(validate_request_budget(&request).is_err());
    request["state"] = json!("");
    for number in 0..64 {
        request["questions"][format!("q{number}")] =
            json!({"type":"noul","instructions":"x".repeat(600)});
    }
    let budget = request_budget(&request).unwrap();
    let length = DECISION_REQUEST_TOKENS - budget.whole_request_bound;
    let text = request["questions"]["q"]["instructions"]
        .as_str()
        .unwrap()
        .to_owned();
    request["questions"]["q"]["instructions"] = json!(text + &"x".repeat(length));
    compare(&request);
    assert_eq!(
        validate_request_budget(&request)
            .unwrap()
            .whole_request_bound,
        DECISION_REQUEST_TOKENS
    );
    let text = request["questions"]["q"]["instructions"]
        .as_str()
        .unwrap()
        .to_owned();
    request["questions"]["q"]["instructions"] = json!(text + "x");
    assert!(validate_request_budget(&request).is_err());
}

#[test]
fn openai_budget_checks_reject_every_unencodable_question() {
    for question in [
        json!({"type":"noul"}),
        json!({"type":"noul","instructions":3}),
        json!({"type":"choice","instructions":"Choose"}),
        json!({"type":"choice","instructions":"Choose","criteria":[]}),
        json!({"type":"score","instructions":"Rate"}),
    ] {
        let request = json!({"model":"gpt-6-luna","state":"evidence","questions":{"q":question}});
        assert!(wire_request(&request).is_err());
        assert!(request_budget(&request).is_err());
    }
    assert!(request_budget(&json!({"model":"gpt-6-luna","questions":{}})).is_err());
}
