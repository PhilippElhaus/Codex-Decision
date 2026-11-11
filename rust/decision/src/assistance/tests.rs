use super::*;

fn ranking() -> Value {
    json!({"workflow":"rank_context","query":"Find the failing assertion",
        "candidates":[{"id":"a","text":"λ exact source\nassert_eq!(left, right);"},{"id":"b","text":"Routine build progress"}]})
}

fn response(request: &Value) -> Value {
    let answers=request["questions"].as_object().unwrap().iter().map(|(name,q)| {
        let answer=match q["type"].as_str().unwrap() {
            "score"=>{
                let levels=q["criteria"].as_array().unwrap();
                let probabilities=levels.iter().enumerate().map(|(i,_)|(i.to_string(),json!(if i==0 {1.0}else{0.0}))).collect::<serde_json::Map<_,_>>();
                json!({"type":"score","score":0.0,"confidence":1.0,"probabilities":probabilities})
            }
            "choice"=>{
                let probabilities=q["criteria"].as_object().unwrap().keys().map(|k|(k.clone(),json!(if k=="unknown"{1.0}else{0.0}))).collect::<serde_json::Map<_,_>>();
                json!({"type":"choice","choice":"unknown","confidence":1.0,"probabilities":probabilities})
            }
            _=>json!({"type":"noul","noul":if name.starts_with("supported"){0.01}else{0.99}}),
        };
        (name.clone(),answer)
    }).collect::<serde_json::Map<_,_>>();
    json!({"model":request["model"],"answers":answers,"usage":{"input_tokens":1200,"output_tokens":20,
        "input_tokens_details":{"cached_tokens":1000,"cache_write_tokens":100}}})
}

#[test]
fn structured_rank_preserves_originals_and_exact_wire_budget() {
    let source = ranking();
    let prepared = prepare(&source, "gpt-6-luna", Provider::OpenAi).unwrap();
    let wire = crate::provider::wire_request(&prepared.request).unwrap();
    assert_eq!(wire["input"][0]["content"][1]["type"], "input_json");
    assert_eq!(
        wire["input"][0]["content"][1]["data"]["candidates"],
        source["candidates"]
    );
    assert_eq!(
        crate::provider::encode_request(&prepared.request).unwrap(),
        serde_json::to_vec(&wire).unwrap()
    );
    assert_eq!(
        crate::semantic::request_budget(&prepared.request)
            .unwrap()
            .whole_request_bound,
        serde_json::to_vec(&wire).unwrap().len() + crate::semantic::TOKEN_HEADROOM
    );
    let result = prepared.finish(&response(&prepared.request)).unwrap();
    assert_eq!(
        result["candidates"][0]["text"],
        source["candidates"][0]["text"]
    );
    assert_eq!(result["candidates"].as_array().unwrap().len(), 2);
    assert_eq!(result["usage"]["input_tokens"], 1200);
    assert_eq!(result["usage"]["cached_tokens"], 1000);
}

#[test]
fn both_protocols_and_custom_models_keep_questions_and_cache_boundaries() {
    for protocol in [Provider::OpenAi, Provider::TypeSafe] {
        let mut source = ranking();
        source["cache_reference"] = json!("A stable reference document");
        let prepared = prepare(
            &source,
            if protocol == Provider::OpenAi {
                "custom-model"
            } else {
                "jev-latest"
            },
            protocol,
        )
        .unwrap();
        let wire = crate::provider::wire_request_for(&prepared.request, protocol).unwrap();
        if protocol == Provider::OpenAi {
            assert_eq!(wire["prompt_cache_options"]["mode"], "explicit");
            assert_eq!(
                wire["input"][0]["content"][1]["prompt_cache_breakpoint"]["mode"],
                "explicit"
            );
            assert_eq!(wire["questions"][0]["levels"].as_array().unwrap().len(), 4);
        } else {
            assert!(wire.get("input").is_none());
            assert_eq!(wire["state"]["reference"], "A stable reference document");
        }
        assert_eq!(
            crate::provider::encode_request_for(&prepared.request, protocol).unwrap(),
            serde_json::to_vec(&wire).unwrap()
        );
        prepared.finish(&response(&prepared.request)).unwrap();
    }
}

#[test]
fn triage_is_advisory_and_verification_distinguishes_contradiction_from_missing_evidence() {
    let triage=prepare(&json!({"workflow":"triage_failure","failure":{"name":"assertion","output":"left 1, right 2"}}),"gpt-6-luna",Provider::OpenAi).unwrap();
    let result = triage.finish(&response(&triage.request)).unwrap();
    assert_eq!(result["test_selection"], "coverage_only");
    assert_eq!(result["advisory"], true);
    let verify = prepare(
        &json!({"workflow":"verify_completion","claims":["All checks passed"],
        "evidence":[{"kind":"test","content":"test failed: expected 2, got 1"}]}),
        "gpt-6-luna",
        Provider::OpenAi,
    )
    .unwrap();
    let mut answered = response(&verify.request);
    assert_eq!(
        verify.finish(&answered).unwrap()["continuation_recommended"],
        true
    );
    answered["answers"]["contradicted_000"]["noul"] = json!(0.01);
    let result = verify.finish(&answered).unwrap();
    assert_eq!(result["claims"][0]["verdict"], "unverified");
    assert_eq!(result["continuation_recommended"], false);
}

#[test]
fn bad_distributions_and_partial_answers_never_publish_a_ranking() {
    let prepared = prepare(&ranking(), "gpt-6-luna", Provider::OpenAi).unwrap();
    for field in ["score", "confidence"] {
        let mut answer = response(&prepared.request);
        answer["answers"]["candidate_000"][field] = json!(-1);
        assert!(prepared.finish(&answer).is_err());
    }
    let mut answer = response(&prepared.request);
    answer["answers"]
        .as_object_mut()
        .unwrap()
        .remove("candidate_001");
    assert!(prepared.finish(&answer).is_err());
    let mut answer = response(&prepared.request);
    answer["answers"]["candidate_000"]["probabilities"]["9"] = json!(0.0);
    assert!(prepared.finish(&answer).is_err());
    let mut answer = response(&prepared.request);
    answer["answers"]["candidate_000"]["score"] = json!(2.0);
    assert!(prepared.finish(&answer).is_err());
}

#[test]
fn invalid_candidates_and_exact_budget_overflows_are_rejected() {
    let mut source = ranking();
    source["candidates"][1]["id"] = json!("a");
    assert!(prepare(&source, "gpt-6-luna", Provider::OpenAi).is_err());
    let mut source = ranking();
    source["candidates"][0]["text"] = json!("a".repeat(24_000));
    source["candidates"][1]["text"] = json!("b".repeat(24_000));
    for protocol in [Provider::OpenAi, Provider::TypeSafe] {
        assert!(prepare(&source, "custom-model", protocol).is_err());
    }
    let mut source = ranking();
    source["unknown"] = json!(true);
    assert!(prepare(&source, "gpt-6-luna", Provider::OpenAi).is_err());
}

#[test]
fn score_wire_requires_contiguous_matching_labels_and_indices() {
    let prepared = prepare(&ranking(), "gpt-6-luna", Provider::OpenAi).unwrap();
    let answers:Vec<_>=prepared.request["questions"].as_object().unwrap().keys().map(|name|json!({
        "name":name,"type":"score","score":0.0,"confidence":1.0,
        "probabilities":(0..4).map(|i|json!({"label":i.to_string(),"value":i,"probability":if i==0 {1.0}else{0.0}})).collect::<Vec<_>>()
    })).collect();
    let mut wire = json!({"model":"gpt-6-luna","answers":answers});
    let normalized = crate::provider::normalize_response(&prepared.request, wire.clone()).unwrap();
    prepared.finish(&normalized).unwrap();
    wire["answers"][0]["probabilities"][0]["value"] = json!(1);
    assert!(crate::provider::normalize_response(&prepared.request, wire).is_err());
}

#[test]
fn cache_counts_are_subsets_and_missing_usage_stays_unknown() {
    assert!(usage(None)["input_tokens"].is_null());
    let value = usage(Some(&json!({"input_tokens":100,"output_tokens":0,
        "input_tokens_details":{"cached_tokens":90,"cache_write_tokens":20}})));
    assert_eq!(value["input_tokens"], 100);
    assert!(value["cached_tokens"].is_null());
    assert!(usage(Some(&json!({"input_tokens":-1})))["input_tokens"].is_null());
}
