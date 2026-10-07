//! Move verified wire answers into the existing named evidence contract.
use super::Provider;
use serde_json::{Map, Value};

pub fn normalize_response(request: &Value, mut response: Value) -> Result<Value, String> {
    let model = request["model"].as_str().ok_or("missing model")?;
    let provider = Provider::for_model(model)?;
    if Provider::for_model(response["model"].as_str().ok_or("missing response model")?)? != provider
    {
        return Err("response provider mismatch".into());
    }
    if provider == Provider::TypeSafe {
        return Ok(response);
    }
    let envelope = response
        .as_object_mut()
        .ok_or("invalid decision envelope")?;
    if envelope
        .keys()
        .any(|key| !["model", "answers", "usage"].contains(&key.as_str()))
    {
        return Err("invalid decision envelope".into());
    }
    let questions = request["questions"]
        .as_object()
        .ok_or("missing questions")?;
    let (answers_key, answers) = envelope
        .remove_entry("answers")
        .ok_or("missing ordered answers")?;
    let Value::Array(answers) = answers else {
        return Err("missing ordered answers".into());
    };
    if answers.len() != questions.len() {
        return Err("decision answer count mismatch".into());
    }
    let mut named = Map::new();
    for ((name, question), answer) in questions.iter().zip(answers) {
        if answer["name"].as_str() != Some(name) {
            return Err("decision answer order or name mismatch".into());
        }
        let Value::Object(mut answer) = answer else {
            return Err("invalid answer".into());
        };
        match (
            question["type"].as_str(),
            answer.get("type").and_then(Value::as_str),
        ) {
            (Some("noul"), Some("predicate")) if answer.len() == 3 => {
                let (mut key, probability) = answer
                    .remove_entry("probability")
                    .unwrap_or_else(|| ("noul".into(), Value::Null));
                key.clear();
                key.push_str("noul");
                let Some(Value::String(name)) = answer.remove("name") else {
                    return Err("decision answer order or name mismatch".into());
                };
                answer.retain(|key, _| key == "type");
                if let Some(Value::String(kind)) = answer.get_mut("type") {
                    kind.clear();
                    kind.push_str("noul");
                }
                answer.insert(key, probability);
                named.insert(name, Value::Object(answer));
            }
            (Some("choice"), Some("choice")) if answer.len() == 5 => {
                let (key, rows) = answer
                    .remove_entry("probabilities")
                    .ok_or("missing choice probabilities")?;
                let Value::Array(rows) = rows else {
                    return Err("missing choice probabilities".into());
                };
                let mut probabilities = Map::new();
                for row in rows {
                    let Value::Object(mut row) = row else {
                        return Err("invalid choice probability".into());
                    };
                    if row.len() != 2 {
                        return Err("invalid choice probability".into());
                    }
                    let Some(Value::String(value)) = row.remove("value") else {
                        return Err("invalid choice value".into());
                    };
                    if probabilities
                        .insert(value, row.remove("probability").unwrap_or(Value::Null))
                        .is_some()
                    {
                        return Err("duplicate choice probability".into());
                    }
                }
                let Some(Value::String(name)) = answer.remove("name") else {
                    return Err("decision answer order or name mismatch".into());
                };
                answer.retain(|key, _| ["type", "choice", "confidence"].contains(&key.as_str()));
                for field in ["choice", "confidence"] {
                    if !answer.contains_key(field) {
                        answer.insert(field.into(), Value::Null);
                    }
                }
                answer.insert(key, Value::Object(probabilities));
                named.insert(name, Value::Object(answer));
            }
            _ => return Err("refused or invalid decision answer".into()),
        }
    }
    envelope.insert(answers_key, Value::Object(named));
    Ok(response)
}
