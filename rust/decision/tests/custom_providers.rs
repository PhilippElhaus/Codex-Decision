use codex_decision::provider::{
    encode_request_for, normalize_custom_response, wire_request_for, CustomProvider, Provider,
};
use serde_json::{json, Value};

fn custom() -> CustomProvider {
    serde_json::from_value(
        json!({"name":"Private decision service","protocol":"openai",
        "endpoint":"https://decisions.example.invalid/v1/decisions","model":"my-team/model-v2",
        "auth":"bearer"}),
    )
    .unwrap()
}

#[test]
fn custom_provider_urls_and_authentication_have_explicit_boundaries() {
    let mut provider = custom();
    for endpoint in [
        "https://decisions.example.invalid/v1/decisions",
        "http://127.0.0.1:8080/decide",
        "http://[::1]:8080/decide",
    ] {
        provider.endpoint = endpoint.into();
        provider.validate().unwrap();
    }
    for endpoint in [
        "http://example.invalid/",
        "http://localhost:8080/",
        "http://127.1:8080/",
        "http://2130706433/",
        "https://user:secret@example.invalid/",
        "https://@example.invalid/",
        "https://example.invalid/?token=secret",
        "https://example.invalid/#fragment",
        "https://example.invalid:0/",
        "https://example.invalid/path\nother",
        "https://example.invalid\\evil/",
    ] {
        provider.endpoint = endpoint.into();
        assert!(provider.validate().is_err(), "accepted {endpoint}");
    }
    provider = custom();
    assert_eq!(
        provider.authorization("synthetic-secret", "").unwrap(),
        Some(("Authorization".into(), "Bearer synthetic-secret".into()))
    );
    assert!(provider
        .authorization("injected\r\nX-Evil: yes", "")
        .is_err());
    provider.auth = "none".into();
    assert_eq!(provider.authorization("", "").unwrap(), None);
    provider.auth = "basic".into();
    provider.username = "test-user".into();
    assert_eq!(
        provider.authorization("", "test password").unwrap(),
        Some((
            "Authorization".into(),
            "Basic dGVzdC11c2VyOnRlc3QgcGFzc3dvcmQ=".into()
        ))
    );
    provider.auth = "header".into();
    provider.header_name = "X-API-Key".into();
    assert_eq!(
        provider.authorization("synthetic-secret", "").unwrap(),
        Some(("X-API-Key".into(), "synthetic-secret".into()))
    );
    for name in [
        "Host",
        "Authorization",
        "Content-Type",
        "Content-Length",
        "Connection",
        "X-Key\r\nHost",
    ] {
        provider.header_name = name.into();
        assert!(provider.validate().is_err(), "accepted {name}");
    }
}

#[test]
fn custom_provider_contract_keeps_legacy_models_and_disables_unselected_fallback() {
    for (protocol, expected) in [("openai", "gpt-6-luna"), ("jev", "jev-latest")] {
        let mut provider = serde_json::to_value(custom()).unwrap();
        provider["protocol"] = protocol.into();
        let mut input = json!({"schema_version":5,"enabled":true,"mode":"replace",
            "provider":"custom","custom_provider":provider,"relevance_policy":{"relevant_max":5}});
        let validated = codex_decision::contract::validate("config", &input).unwrap();
        assert_eq!(validated["model"], expected);
        assert_eq!(validated["custom_provider"]["model"], "my-team/model-v2");
        input["fallback_enabled"] = true.into();
        assert!(codex_decision::contract::validate("config", &input).is_err());
        input["fallback_enabled"] = false.into();
        input["custom_provider"]["password"] = "never-in-config".into();
        assert!(codex_decision::contract::validate("config", &input).is_err());
    }
}

#[test]
fn either_schema_encodes_custom_models_and_rejects_cross_model_answers() {
    let request = json!({"model":"my-team/model-v2","state":{"text":"synthetic status"},
        "questions":{"line_1":{"type":"noul","instructions":"Is line 1 required?"}}});
    for protocol in [Provider::OpenAi, Provider::TypeSafe] {
        let encoded: Value =
            serde_json::from_slice(&encode_request_for(&request, protocol).unwrap()).unwrap();
        assert_eq!(encoded, wire_request_for(&request, protocol).unwrap());
        assert_eq!(encoded["model"], "my-team/model-v2");
        assert_eq!(
            encoded["questions"].is_array(),
            protocol == Provider::OpenAi
        );
        let response = if protocol == Provider::OpenAi {
            json!({"model":"my-team/model-v2","answers":[{"name":"line_1","type":"predicate","probability":0.01}]})
        } else {
            json!({"model":"my-team/model-v2","answers":{"line_1":{"type":"noul","noul":0.01}}})
        };
        let normalized = normalize_custom_response(&request, response.clone(), protocol).unwrap();
        assert_eq!(normalized["answers"]["line_1"]["noul"], 0.01);
        let mut mismatch = response;
        mismatch["model"] = "a-different-model".into();
        assert!(normalize_custom_response(&request, mismatch, protocol).is_err());
    }
}

#[test]
fn credential_identity_changes_only_with_the_connection_target_or_authentication() {
    let provider = custom();
    let expected = "537272ca2dcf0a67b9a7d9c3eb49c08e84147718611f2394acfa4f005807b262";
    assert_eq!(provider.credential_identity(), expected);
    let mut other = provider.clone();
    other.name = "New label".into();
    other.model = "new-model".into();
    assert_eq!(provider.credential_identity(), other.credential_identity());
    other.endpoint.push_str("/other");
    assert_ne!(provider.credential_identity(), other.credential_identity());
}
