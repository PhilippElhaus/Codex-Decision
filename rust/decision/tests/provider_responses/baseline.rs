//! Frozen normalization oracle from commit 4b24210; test code only.
use codex_decision::provider::Provider;
use serde_json::{json, Map, Value};

pub fn normalize_response(request: &Value, response: Value) -> Result<Value, String> {
    let model = request["model"].as_str().ok_or("missing model")?;
    let provider = Provider::for_model(model)?;
    if Provider::for_model(response["model"].as_str().ok_or("missing response model")?)? != provider
    {
        return Err("response provider mismatch".into());
    }
    if provider == Provider::TypeSafe {
        return Ok(response);
    }
    let envelope = response.as_object().ok_or("invalid decision envelope")?;
    if envelope
        .keys()
        .any(|key| !["model", "answers", "usage"].contains(&key.as_str()))
    {
        return Err("invalid decision envelope".into());
    }
    let questions = request["questions"]
        .as_object()
        .ok_or("missing questions")?;
    let answers = response["answers"]
        .as_array()
        .ok_or("missing ordered answers")?;
    if answers.len() != questions.len() {
        return Err("decision answer count mismatch".into());
    }
    let mut named = Map::new();
    for ((name, question), answer) in questions.iter().zip(answers) {
        if answer["name"].as_str() != Some(name) {
            return Err("decision answer order or name mismatch".into());
        }
        let object = answer.as_object().ok_or("invalid answer")?;
        let normalized = match (question["type"].as_str(), answer["type"].as_str()) {
            (Some("noul"), Some("predicate")) if object.len() == 3 => {
                json!({"type":"noul","noul":answer["probability"]})
            }
            (Some("choice"), Some("choice")) if object.len() == 5 => {
                let mut probabilities = Map::new();
                for row in answer["probabilities"]
                    .as_array()
                    .ok_or("missing choice probabilities")?
                {
                    if row.as_object().is_none_or(|o| o.len() != 2) {
                        return Err("invalid choice probability".into());
                    }
                    let value = row["value"].as_str().ok_or("invalid choice value")?;
                    if probabilities
                        .insert(value.into(), row["probability"].clone())
                        .is_some()
                    {
                        return Err("duplicate choice probability".into());
                    }
                }
                json!({"type":"choice","choice":answer["choice"],"confidence":answer["confidence"],"probabilities":probabilities})
            }
            _ => return Err("refused or invalid decision answer".into()),
        };
        named.insert(name.clone(), normalized);
    }
    let mut normalized = json!({"model":response["model"],"answers":named});
    if let Some(usage) = response.get("usage") {
        normalized["usage"] = usage.clone();
    }
    Ok(normalized)
}
