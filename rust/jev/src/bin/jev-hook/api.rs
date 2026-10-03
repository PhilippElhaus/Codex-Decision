//! Bounded Jev line and Choice requests.
use super::*;

pub(super) fn evaluate(
    agent: &ureq::Agent,
    request: &Value,
    key: &str,
    timeout: f64,
) -> Result<Value, String> {
    let encoded = serde_json::to_vec(request).map_err(|_| "request encoding")?;
    validate_request_budget(request)?;
    #[cfg(debug_assertions)]
    let endpoint = std::env::var("CODEX_JEV_TEST_ENDPOINT")
        .ok()
        .filter(|value| value.starts_with("http://127.0.0.1:"))
        .unwrap_or_else(|| "https://api.typesafe.ai/v1/systemone".into());
    #[cfg(not(debug_assertions))]
    let endpoint = "https://api.typesafe.ai/v1/systemone".to_owned();
    let response = agent
        .post(&endpoint)
        .timeout(Duration::from_secs_f64(timeout))
        .set("Authorization", &format!("Bearer {key}"))
        .set("Content-Type", "application/json")
        .send_bytes(&encoded)
        .map_err(|_| "Jev request failed")?;
    let mut body = Vec::new();
    response
        .into_reader()
        .take(1_000_001)
        .read_to_end(&mut body)
        .map_err(|_| "Jev response read failed")?;
    if body.len() > 1_000_000 {
        return Err("Jev response too large".into());
    }
    serde_json::from_slice(&body).map_err(|_| "invalid Jev response".into())
}
