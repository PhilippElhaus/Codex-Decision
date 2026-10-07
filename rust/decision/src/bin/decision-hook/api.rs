//! Bounded Decision line and Choice requests.
use super::*;

pub(super) fn evaluate(
    agent: &ureq::Agent,
    request: &Value,
    key: &str,
    timeout: f64,
) -> Result<Value, String> {
    validate_request_budget(request)?;
    let provider = codex_decision::provider::Provider::for_model(
        request["model"].as_str().ok_or("missing model")?,
    )?;
    let encoded = codex_decision::provider::encode_request(request)?;
    #[cfg(debug_assertions)]
    let endpoint = std::env::var("CODEX_DECISION_TEST_ENDPOINT")
        .ok()
        .filter(|value| value.starts_with("http://127.0.0.1:"))
        .unwrap_or_else(|| provider.endpoint().into());
    #[cfg(not(debug_assertions))]
    let endpoint = provider.endpoint().to_owned();
    let response = agent
        .post(&endpoint)
        .timeout(Duration::from_secs_f64(timeout))
        .set("Authorization", &format!("Bearer {key}"))
        .set("Content-Type", "application/json")
        .send_bytes(&encoded)
        .map_err(|_| "Decision request failed")?;
    let mut body = Vec::new();
    response
        .into_reader()
        .take(1_000_001)
        .read_to_end(&mut body)
        .map_err(|_| "Decision response read failed")?;
    if body.len() > 1_000_000 {
        return Err("Decision response too large".into());
    }
    let response = strict_json::parse(&body).map_err(|_| "invalid decision response")?;
    codex_decision::provider::normalize_response(request, response)
}
