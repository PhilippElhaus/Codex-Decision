use codex_decision::{provider::*, semantic::*, source_lines};
use serde_json::{json, Value};

fn predicate_request() -> Value {
    json!({"model":"gpt-6-luna","state":{"task":"Find the failure","lines":[{"text":"λ failure"}]},
        "questions":{"line_2":{"type":"noul","instructions":"Is line 2 required?","criteria":{"true":"Required evidence","false":"Routine progress"}},
        "line_10":{"type":"noul","instructions":"Is line 10 required?"}}})
}

#[test]
fn openai_wire_preserves_evidence_and_question_order() {
    let request = predicate_request();
    let wire = wire_request(&request).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(wire["input"].as_str().unwrap()).unwrap(),
        request["state"]
    );
    assert!(wire.get("state").is_none());
    assert_eq!(wire["questions"][0]["name"], "line_10");
    assert_eq!(wire["questions"][1]["name"], "line_2");
    assert_eq!(wire["questions"][1]["type"], "predicate");
    assert!(wire["questions"][1]["instructions"]
        .as_str()
        .unwrap()
        .contains("Required evidence"));
    let normalized = normalize_response(
        &request,
        json!({"model":"gpt-6-luna","answers":[
        {"name":"line_10","type":"predicate","probability":0.9},
        {"name":"line_2","type":"predicate","probability":0.01}]}),
    )
    .unwrap();
    assert_eq!(normalized["answers"]["line_10"]["noul"], 0.9);
    assert_eq!(normalized["answers"]["line_2"]["noul"], 0.01);
    let mut swapped = json!({"model":"gpt-6-luna","answers":[
        {"name":"line_2","type":"predicate","probability":0.9},
        {"name":"line_10","type":"predicate","probability":0.01}]});
    assert!(normalize_response(&request, swapped.clone()).is_err());
    swapped["answers"][0] = json!({"name":"line_10","type":"refusal"});
    assert!(normalize_response(&request, swapped).is_err());
}

#[test]
fn choice_distribution_has_the_same_evidence_gate_for_both_providers() {
    let request = classification_request(
        "Find the failure",
        "Bash",
        "cargo test",
        &Value::Null,
        &source_lines("INFO routine\nerror: test failed\n"),
        "gpt-6-luna",
    );
    let choices = wire_request(&request).unwrap()["questions"][0]["choices"].clone();
    assert_eq!(choices.as_array().unwrap().len(), KINDS.len());
    let probabilities: Vec<_> = KINDS.iter().map(|value| json!({"value":value,"probability":if *value == "repetitive_log" {0.98} else {0.02/7.0}})).collect();
    let response = json!({"model":"gpt-6-luna","answers":[{"name":"output_kind","type":"choice",
        "choice":"repetitive_log","confidence":0.98,"probabilities":probabilities}],
        "usage":{"input_tokens":100,"output_tokens":0,"total_tokens":100}});
    let normalized = normalize_response(&request, response.clone()).unwrap();
    assert_eq!(
        classification(&normalized).unwrap(),
        ("repetitive_log".into(), true)
    );
    let mut duplicate = response.clone();
    duplicate["answers"][0]["probabilities"][1] =
        duplicate["answers"][0]["probabilities"][0].clone();
    assert!(normalize_response(&request, duplicate).is_err());
    let mut wrong_model = response;
    wrong_model["model"] = "jev-latest".into();
    assert!(normalize_response(&request, wrong_model).is_err());
}

#[test]
fn legacy_configs_keep_typesafe_and_new_configs_default_to_openai() {
    let legacy = codex_decision::contract::validate("config", &json!({"schema_version":4,"enabled":true,"mode":"replace","relevance_policy":{"relevant_max":5}})).unwrap();
    assert_eq!(legacy["provider"], "typesafe");
    assert_eq!(legacy["model"], "jev-latest");
    let current = codex_decision::contract::validate("config", &json!({"schema_version":5,"enabled":true,"mode":"replace","relevance_policy":{"relevant_max":5}})).unwrap();
    assert_eq!(current["provider"], "openai");
    assert_eq!(current["model"], "gpt-6-luna");
    let mut mismatch = current;
    mismatch["provider"] = "typesafe".into();
    assert!(codex_decision::contract::validate("config", &mismatch).is_err());
    assert_eq!(Provider::OpenAi.key_name(), "OPENAI_API_KEY");
    assert_eq!(Provider::TypeSafe.key_name(), "JEV_API_KEY");
}
