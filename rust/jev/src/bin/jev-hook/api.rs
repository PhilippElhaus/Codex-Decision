//! Bounded Jev line and Choice requests.
use super::*;

pub(super) fn evaluate(
    agent: &ureq::Agent,
    request: &Value,
    key: &str,
    timeout: f64,
) -> Result<Value, String> {
    let encoded = serde_json::to_vec(request).map_err(|_| "request encoding")?;
    if encoded.len() > MAX_REQUEST_BYTES {
        return Err("request too large".into());
    }
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

pub(super) fn choice_request(
    task: &str,
    command: &str,
    lines: &[SourceLine],
    model: &str,
) -> Value {
    let eligible: Vec<&SourceLine> = lines
        .iter()
        .filter(|line| line.eligible && line.protected_reason.is_none())
        .collect();
    let mut samples = Vec::new();
    let count = eligible.len().min(21);
    for index in 0..count {
        let position = if count == 1 {
            0
        } else {
            index * (eligible.len() - 1) / (count - 1)
        };
        let line = eligible[position];
        samples.push(json!({"line":line.number,
            "text":line.model_text.chars().take(180).collect::<String>()}));
    }
    json!({"model":model,"state":{"task":task.chars().take(500).collect::<String>(),
        "command":command.chars().take(400).collect::<String>(),
        "line_count":lines.len(),"eligible_count":eligible.len(),"sample":samples},
        "questions":{"line_filter_fit":{"type":"choice",
            "instructions":"Would independent per-line filtering usefully remove routine repetition from this output while preserving task-relevant evidence? Judge only this sampled output. Choose uncertain if the sample is mixed or insufficient.",
            "criteria":{
                "line_filter":"Mostly repetitive standalone progress, status, or log lines; removing many routine lines would be useful.",
                "keep_full":"Mostly connected prose, source code, configuration, structured data, or distinct values where line removal would lose useful context or save little.",
                "uncertain":"Mixed or insufficient evidence; preserve the entire result."}}}})
}

pub(super) fn choice_allows_line_filter(response: &Value) -> Result<bool, String> {
    let answer = response
        .pointer("/answers/line_filter_fit")
        .ok_or("missing Jev choice")?;
    if answer.get("type").and_then(Value::as_str) != Some("choice") {
        return Err("invalid Jev choice type".into());
    }
    let selected = answer
        .get("choice")
        .and_then(Value::as_str)
        .ok_or("missing Jev choice option")?;
    let probabilities = answer
        .get("probabilities")
        .and_then(Value::as_object)
        .ok_or("missing Jev choice probabilities")?;
    let options = ["line_filter", "keep_full", "uncertain"];
    if probabilities.len() != options.len() || !options.contains(&selected) {
        return Err("invalid Jev choice options".into());
    }
    let mut total = 0.0;
    let mut selected_probability = 0.0;
    for option in options {
        let value = probabilities
            .get(option)
            .and_then(Value::as_f64)
            .ok_or("missing Jev choice probability")?;
        if !value.is_finite() || !(0.0..=1.0).contains(&value) {
            return Err("invalid Jev choice probability".into());
        }
        total += value;
        if option == selected {
            selected_probability = value;
        }
    }
    let confidence = answer
        .get("confidence")
        .and_then(Value::as_f64)
        .ok_or("missing Jev choice confidence")?;
    if !confidence.is_finite()
        || !(0.0..=1.0).contains(&confidence)
        || (total - 1.0).abs() > 0.02
        || probabilities
            .values()
            .filter_map(Value::as_f64)
            .any(|value| value > selected_probability + 1e-9)
    {
        return Err("invalid Jev choice distribution".into());
    }
    Ok(selected == "line_filter" && selected_probability >= 0.80 && confidence >= 0.70)
}
