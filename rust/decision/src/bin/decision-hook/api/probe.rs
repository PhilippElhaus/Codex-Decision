//! Run a synthetic connection check without loading or writing saved settings.
use super::*;
use codex_decision::provider::{encode_request_for, valid_builtin_key, CustomProvider, Provider};
use std::error::Error;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Draft {
    provider: String,
    custom_provider: Option<CustomProvider>,
    credential: String,
    timeout_ms: u64,
}

fn result(draft: Draft) -> Result<Value, String> {
    let selected = Provider::parse(&draft.provider).map_err(|_| "DECISION_INVALID_SETTINGS")?;
    let connection = match (selected, draft.custom_provider) {
        (Provider::Custom, Some(custom)) => {
            custom.validate().map_err(|_| "DECISION_INVALID_SETTINGS")?;
            Connection::custom(&custom, &draft.credential, &draft.credential)
                .map_err(|_| "DECISION_KEY_INVALID")?
        }
        (Provider::Custom, None) | (_, Some(_)) => return Err("DECISION_INVALID_SETTINGS".into()),
        (provider, None) => {
            if !valid_builtin_key(&draft.credential) {
                return Err("DECISION_KEY_INVALID".into());
            }
            Connection::builtin(provider, provider.default_model(), &draft.credential)
                .map_err(|_| "DECISION_INVALID_SETTINGS")?
        }
    };
    let request = json!({
        "model": connection.model,
        "state": {"output_sample":"Compiling module 1 done\nCompiling module 2 done"},
        "questions": {"ready":{"type":"noul","instructions":"Is output_sample routine build progress?"}}
    });
    let encoded = encode_request_for(&request, connection.protocol)
        .map_err(|_| "DECISION_INVALID_SETTINGS")?;
    let response = post(
        &connection.agent(),
        &connection.endpoint,
        connection.header.as_ref(),
        Duration::from_millis(draft.timeout_ms.clamp(1, 6000)),
        &encoded,
    );
    let response = match response {
        Ok(response) if (200..300).contains(&response.status()) => response,
        Ok(response) if response.status() >= 400 => {
            return Err(http_reason(response.status(), response))
        }
        Ok(_) => return Err("DECISION_NETWORK_ERROR".into()),
        Err(error) => return Err(network_reason(error.as_ref()).into()),
    };
    let bytes = body(response, 262_144).ok_or("DECISION_INVALID_RESPONSE")?;
    let wire = strict_json::parse(&bytes).map_err(|_| "DECISION_INVALID_RESPONSE")?;
    let actual = wire["model"].as_str().ok_or("DECISION_INVALID_RESPONSE")?;
    let expected = if connection.response_model.is_empty() {
        &connection.model
    } else {
        &connection.response_model
    };
    let valid_model = if selected == Provider::TypeSafe {
        actual.starts_with("jev-")
    } else {
        actual == expected
    };
    if !valid_model {
        return Err("DECISION_INVALID_RESPONSE".into());
    }
    let probability = if connection.protocol == Provider::OpenAi {
        let answers = wire["answers"]
            .as_array()
            .filter(|answers| answers.len() == 1)
            .ok_or("DECISION_INVALID_RESPONSE")?;
        let answer = &answers[0];
        // Connection tests have always ignored unrelated response metadata.
        // Project the documented answer before using the normal wire decoder.
        let normalized = connection.normalize(&request, json!({"model":actual,
            "answers":[{"name":answer["name"], "type":answer["type"], "probability":answer["probability"]}]}))
            .map_err(|_| "DECISION_INVALID_RESPONSE")?;
        normalized["answers"]["ready"]["noul"].as_f64()
    } else {
        let answer = &wire["answers"]["ready"];
        if answer["type"] != "noul" {
            return Err("DECISION_INVALID_RESPONSE".into());
        }
        answer["noul"].as_f64()
    };
    if !probability.is_some_and(|value| (0.0..=1.0).contains(&value)) {
        return Err("DECISION_INVALID_RESPONSE".into());
    }
    Ok(json!({"ok":true,"model":actual}))
}

fn body(response: ureq::Response, limit: u64) -> Option<Vec<u8>> {
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    (bytes.len() as u64 <= limit).then_some(bytes)
}

fn http_reason(status: u16, response: ureq::Response) -> String {
    if matches!(status, 401 | 403) {
        if let Some(value) = body(response, 4096).and_then(|bytes| strict_json::parse(&bytes).ok())
        {
            if [
                &value["code"],
                &value["message"],
                &value["error"]["code"],
                &value["error"]["message"],
            ]
            .iter()
            .any(|text| {
                text.as_str()
                    .is_some_and(|text| text.to_ascii_lowercase().contains("expir"))
            }) {
                return "DECISION_KEY_EXPIRED".into();
            }
        }
    }
    format!("DECISION_HTTP_{status}")
}

fn network_reason(error: &(dyn Error + 'static)) -> &'static str {
    let mut cause = Some(error);
    while let Some(error) = cause {
        if error.downcast_ref::<std::io::Error>().is_some_and(|error| {
            matches!(
                error.kind(),
                std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
            )
        }) {
            return "DECISION_TIMEOUT";
        }
        cause = error.source();
    }
    "DECISION_NETWORK_ERROR"
}

pub(crate) fn run() {
    let mut input = Vec::new();
    let response = (|| {
        std::io::stdin()
            .take(32_769)
            .read_to_end(&mut input)
            .map_err(|_| "DECISION_INVALID_SETTINGS")?;
        if input.len() > 32_768 {
            return Err("DECISION_INVALID_SETTINGS".into());
        }
        let value = strict_json::parse(&input).map_err(|_| "DECISION_INVALID_SETTINGS")?;
        result(serde_json::from_value(value).map_err(|_| "DECISION_INVALID_SETTINGS")?)
    })();
    let value = response.unwrap_or_else(|reason| json!({"ok":false, "reason":reason}));
    println!("{value}");
}
