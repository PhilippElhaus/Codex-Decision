//! Bounded Decision line and Choice requests.
use super::*;

#[path = "api/connection.rs"]
mod connection;
#[path = "api/endpoint.rs"]
mod endpoint;
pub(super) use connection::Connection;

pub(super) fn decision_agent() -> ureq::Agent {
    // Decision POSTs use fixed endpoints. Redirects would add untracked GETs.
    ureq::AgentBuilder::new().redirects(0).build()
}

#[derive(Debug)]
pub(super) struct EvaluationFailure {
    pub(super) reason: String,
    pub(super) provider_unavailable: bool,
}

impl From<String> for EvaluationFailure {
    fn from(reason: String) -> Self {
        Self {
            reason,
            provider_unavailable: false,
        }
    }
}

impl From<&str> for EvaluationFailure {
    fn from(reason: &str) -> Self {
        reason.to_owned().into()
    }
}

impl EvaluationFailure {
    fn provider(reason: String) -> Self {
        Self {
            reason,
            provider_unavailable: true,
        }
    }
}

pub(super) fn evaluate<T>(
    scoped: &Path,
    agent: &ureq::Agent,
    request: &Value,
    connection: &Connection,
    timeout: f64,
    validate: impl FnOnce(&Value) -> Result<T, String>,
) -> Result<(Value, T), EvaluationFailure> {
    validate_request_budget(request)?;
    let mut wire_source = std::borrow::Cow::Borrowed(request);
    if connection.custom {
        wire_source.to_mut()["model"] = Value::from(connection.model.as_str());
    }
    let encoded = codex_decision::provider::encode_request_for(&wire_source, connection.protocol)?;
    if encoded.len().saturating_add(TOKEN_HEADROOM) > DECISION_REQUEST_TOKENS {
        return Err("Decision context budget".into());
    }
    evaluate_prepared_inner(
        scoped,
        agent,
        request,
        &wire_source,
        &encoded,
        connection,
        timeout,
        validate,
    )
}

#[allow(clippy::too_many_arguments)] // Keep the tested transport and typed-answer boundary explicit.
#[cfg(test)]
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
    let connection = Connection {
        protocol: codex_decision::provider::Provider::for_model(
            request["model"].as_str().ok_or("missing model")?,
        )?,
        endpoint: endpoint.into(),
        model: request["model"].as_str().unwrap().into(),
        header: Some(("Authorization".into(), format!("Bearer {key}"))),
        custom: false,
    };
    evaluate_prepared_inner(
        scoped,
        agent,
        request,
        request,
        encoded,
        &connection,
        timeout,
        validate,
    )
    .map_err(|error| error.reason)
}

#[allow(clippy::too_many_arguments)] // Keep local durability errors separate from provider failures.
fn evaluate_prepared_inner<T>(
    scoped: &Path,
    agent: &ureq::Agent,
    request: &Value,
    wire_source: &Value,
    encoded: &[u8],
    connection: &Connection,
    timeout: f64,
    validate: impl FnOnce(&Value) -> Result<T, String>,
) -> Result<(Value, T), EvaluationFailure> {
    // Count attempts before sending, including requests whose answers fail.
    // Completion statistics still roll back with an unsuccessful result.
    hook_health(scoped, "request", "")?;
    let started = Instant::now();
    let mut outcome = RequestOutcome::default();
    let result: Result<(Value, T), EvaluationFailure> = (|| {
        let body = send_request(
            scoped,
            agent,
            encoded,
            connection.header.as_ref(),
            timeout,
            &connection.endpoint,
            &mut outcome,
        )
        .map_err(|error| match error.as_str() {
            "Decision request failed"
            | "Decision response read failed"
            | "Decision response too large" => EvaluationFailure::provider(error),
            _ => EvaluationFailure::from(error),
        })?;
        let response = strict_json::parse(&body)
            .map_err(|_| EvaluationFailure::provider("invalid decision response".into()))?;
        let mut response = if connection.custom {
            codex_decision::provider::normalize_custom_response(
                wire_source,
                response,
                connection.protocol,
            )
        } else {
            codex_decision::provider::normalize_response(request, response)
        }
        .map_err(EvaluationFailure::provider)?;
        // Typed evidence validation keeps its established model contract. The
        // custom identity was checked against the actual wire model above.
        let actual_model = connection
            .custom
            .then(|| std::mem::replace(&mut response["model"], request["model"].clone()));
        let judgment = validate(&response).map_err(EvaluationFailure::provider)?;
        if let Some(actual_model) = actual_model {
            response["model"] = actual_model;
        }
        Ok((response, judgment))
    })();
    usage::request(
        request,
        if connection.custom {
            "custom"
        } else {
            connection.protocol.name()
        },
        connection.protocol.name(),
        usage::milliseconds(started),
        encoded.len(),
        outcome.response_bytes,
        outcome.http_status,
        outcome.received,
        outcome.cancelled,
        result.as_ref().err().map(|error| error.reason.as_str()),
        result
            .as_ref()
            .ok()
            .and_then(|(response, _)| response.get("usage")),
    );
    if !outcome.cancelled {
        request_result(scoped, outcome.received, result.is_ok())?;
    }
    result
}

#[derive(Default)]
struct RequestOutcome {
    received: bool,
    cancelled: bool,
    http_status: Option<u16>,
    response_bytes: usize,
}

fn send_request(
    scoped: &Path,
    agent: &ureq::Agent,
    encoded: &[u8],
    header: Option<&(String, String)>,
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
    let mut outgoing = agent
        .post(endpoint)
        .timeout(Duration::from_secs_f64(timeout).min(remaining))
        .set("Content-Type", "application/json");
    if let Some((name, value)) = header {
        outgoing = outgoing.set(name, value);
    }
    let response = match outgoing.send_bytes(encoded) {
        Ok(response) => {
            outcome.received = true;
            outcome.http_status = Some(response.status());
            if !(200..300).contains(&response.status()) {
                return Err("Decision request failed".into());
            }
            response
        }
        Err(ureq::Error::Status(status, _)) => {
            outcome.received = true;
            outcome.http_status = Some(status);
            return Err("Decision request failed".into());
        }
        Err(_) => return Err("Decision request failed".into()),
    };
    let mut body = Vec::new();
    let read = response
        .into_reader()
        .take(1_000_001)
        .read_to_end(&mut body);
    outcome.response_bytes = body.len();
    read.map_err(|_| "Decision response read failed")?;
    if body.len() > 1_000_000 {
        return Err("Decision response too large".into());
    }
    Ok(body)
}

#[cfg(test)]
#[path = "api_tests.rs"]
mod tests;
