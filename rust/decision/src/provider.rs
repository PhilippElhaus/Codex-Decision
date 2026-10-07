//! Provider wire formats. The evidence pipeline uses one named-question contract.
use serde_json::{json, Map, Value};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    OpenAi,
    TypeSafe,
}

impl Provider {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "openai" => Ok(Self::OpenAi),
            "typesafe" => Ok(Self::TypeSafe),
            _ => Err("invalid decision provider".into()),
        }
    }

    pub fn for_model(model: &str) -> Result<Self, String> {
        if model == "gpt-6-luna" {
            Ok(Self::OpenAi)
        } else if model.starts_with("jev-") {
            Ok(Self::TypeSafe)
        } else {
            Err("unsupported decision model".into())
        }
    }

    pub fn endpoint(self) -> &'static str {
        match self {
            Self::OpenAi => "https://api.openai.com/v1/decisions",
            Self::TypeSafe => "https://api.typesafe.ai/v1/systemone",
        }
    }

    pub fn key_name(self) -> &'static str {
        match self {
            Self::OpenAi => "OPENAI_API_KEY",
            Self::TypeSafe => "JEV_API_KEY",
        }
    }
}

pub fn wire_request(request: &Value) -> Result<Value, String> {
    if Provider::for_model(request["model"].as_str().ok_or("missing model")?)? == Provider::TypeSafe
    {
        return Ok(request.clone());
    }
    let questions = request["questions"]
        .as_object()
        .ok_or("missing questions")?;
    let mut ordered = Vec::with_capacity(questions.len());
    for (name, question) in questions {
        let mut instructions = question["instructions"]
            .as_str()
            .ok_or("invalid instructions")?
            .to_owned();
        let answer = match question["type"].as_str() {
            Some("noul") => {
                if let Some(criteria) = question.get("criteria") {
                    instructions.push_str("\nPredicate criteria: ");
                    instructions.push_str(&criteria.to_string());
                }
                json!({"name":name,"type":"predicate","instructions":instructions})
            }
            Some("choice") => {
                let criteria = question["criteria"].as_object().ok_or("missing choices")?;
                let choices: Vec<_> = criteria.iter().map(|(value, description)| {
                    json!({"value":value,"description":description.as_str().unwrap_or("")})
                }).collect();
                json!({"name":name,"type":"choice","instructions":instructions,"choices":choices})
            }
            _ => return Err("unsupported decision question".into()),
        };
        ordered.push(answer);
    }
    Ok(json!({"model":request["model"],"input":request["state"].to_string(),"questions":ordered}))
}

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
