//! Bounded Decision line and Choice requests.
use super::*;

#[path = "api/endpoint.rs"]
mod endpoint;

pub(super) fn decision_agent() -> ureq::Agent {
    // Decision POSTs use fixed endpoints. Redirects would add untracked GETs.
    ureq::AgentBuilder::new().redirects(0).build()
}

pub(super) fn evaluate<T>(
    scoped: &Path,
    agent: &ureq::Agent,
    request: &Value,
    key: &str,
    timeout: f64,
    validate: impl FnOnce(&Value) -> Result<T, String>,
) -> Result<(Value, T), String> {
    validate_request_budget(request)?;
    let provider = codex_decision::provider::Provider::for_model(
        request["model"].as_str().ok_or("missing model")?,
    )?;
    let encoded = codex_decision::provider::encode_request(request)?;
    if encoded.len().saturating_add(TOKEN_HEADROOM) > DECISION_REQUEST_TOKENS {
        return Err("Decision context budget".into());
    }
    let endpoint = endpoint::endpoint(provider)?;
    evaluate_prepared(
        scoped, agent, request, &encoded, key, timeout, &endpoint, validate,
    )
}

#[allow(clippy::too_many_arguments)] // Keep the tested transport and typed-answer boundary explicit.
fn evaluate_prepared<T>(
    scoped: &Path,
    agent: &ureq::Agent,
    request: &Value,
    encoded: &[u8],
    key: &str,
    timeout: f64,
    endpoint: &str,
    validate: impl FnOnce(&Value) -> Result<T, String>,
) -> Result<(Value, T), String> {
    // Count attempts before sending, including requests whose answers fail.
    // Completion statistics still roll back with an unsuccessful result.
    hook_health(scoped, "request", "")?;
    let mut outcome = RequestOutcome::default();
    let result = (|| {
        let body = send_request(scoped, agent, encoded, key, timeout, endpoint, &mut outcome)?;
        let response = strict_json::parse(&body).map_err(|_| "invalid decision response")?;
        let response = codex_decision::provider::normalize_response(request, response)?;
        let judgment = validate(&response)?;
        Ok((response, judgment))
    })();
    if !outcome.cancelled {
        request_result(scoped, outcome.received, result.is_ok())?;
    }
    result
}

#[derive(Default)]
struct RequestOutcome {
    received: bool,
    cancelled: bool,
}

fn send_request(
    scoped: &Path,
    agent: &ureq::Agent,
    encoded: &[u8],
    key: &str,
    timeout: f64,
    endpoint: &str,
    outcome: &mut RequestOutcome,
) -> Result<Vec<u8>, String> {
    // Local validation, encoding and durable attempt registration consume the
    // same invocation budget. ureq starts its timer only when sending begins.
    let remaining = match remaining() {
        Ok(remaining) => remaining,
        Err(error) => {
            outcome.cancelled = true;
            hook_health(scoped, "request_cancelled", "hook deadline before send")?;
            return Err(error);
        }
    };
    let response = match agent
        .post(endpoint)
        .timeout(Duration::from_secs_f64(timeout).min(remaining))
        .set("Authorization", &format!("Bearer {key}"))
        .set("Content-Type", "application/json")
        .send_bytes(encoded)
    {
        Ok(response) => {
            outcome.received = true;
            if !(200..300).contains(&response.status()) {
                return Err("Decision request failed".into());
            }
            response
        }
        Err(ureq::Error::Status(_, _)) => {
            outcome.received = true;
            return Err("Decision request failed".into());
        }
        Err(_) => return Err("Decision request failed".into()),
    };
    let mut body = Vec::new();
    response
        .into_reader()
        .take(1_000_001)
        .read_to_end(&mut body)
        .map_err(|_| "Decision response read failed")?;
    if body.len() > 1_000_000 {
        return Err("Decision response too large".into());
    }
    Ok(body)
}

#[cfg(test)]
#[path = "api_tests.rs"]
mod tests;
