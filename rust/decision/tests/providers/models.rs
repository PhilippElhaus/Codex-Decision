use codex_decision::provider::normalize_response;
use serde_json::json;

#[test]
fn typesafe_pinned_response_must_match_the_requested_version() {
    let request = json!({"model":"jev-1.13.0"});
    assert!(normalize_response(&request, json!({"model":"jev-1.12.0","answers":{}})).is_err());
    assert!(normalize_response(&request, json!({"model":"jev-latest","answers":{}})).is_err());
    assert!(normalize_response(&request, json!({"model":"jev-1.13.0","answers":{}})).is_ok());
}

#[test]
fn documented_typesafe_aliases_accept_versioned_answers_without_pinning_an_alias_map() {
    for alias in ["jev-latest", "jev-preview"] {
        let request = json!({"model":alias});
        for actual in ["jev-1.13.0", "jev-2.0.1", alias] {
            assert!(normalize_response(&request, json!({"model":actual,"answers":{}})).is_ok());
        }
    }
}

#[test]
fn unknown_or_malformed_typesafe_models_never_validate_by_prefix_alone() {
    let request = json!({"model":"jev-latest"});
    for actual in [
        "jev-foo",
        "jev-preview",
        "jev-1.13",
        "jev-01.13.0",
        "jev-1.13.0-extra",
        "jev-1.13.-1",
        "jev-1.13.0/",
    ] {
        assert!(
            normalize_response(&request, json!({"model":actual,"answers":{}})).is_err(),
            "accepted {actual}"
        );
    }
    assert!(normalize_response(
        &json!({"model":"jev-foo"}),
        json!({"model":"jev-foo","answers":{}})
    )
    .is_err());
}
