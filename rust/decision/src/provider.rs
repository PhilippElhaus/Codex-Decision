//! Provider wire formats. The evidence pipeline uses one named-question contract.
use serde_json::{json, Value};
use std::fmt::Write;

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
        let mut answer = match question["type"].as_str() {
            Some("noul") => {
                if let Some(criteria) = question.get("criteria") {
                    instructions.push_str("\nPredicate criteria: ");
                    write!(&mut instructions, "{criteria}").map_err(|_| "invalid instructions")?;
                }
                json!({"name":name,"type":"predicate"})
            }
            Some("choice") => {
                let criteria = question["criteria"].as_object().ok_or("missing choices")?;
                let choices: Vec<_> = criteria.iter().map(|(value, description)| {
                    json!({"value":value,"description":description.as_str().unwrap_or("")})
                }).collect();
                let mut answer = json!({"name":name,"type":"choice"});
                answer["choices"] = Value::Array(choices);
                answer
            }
            _ => return Err("unsupported decision question".into()),
        };
        answer["instructions"] = Value::String(instructions);
        ordered.push(answer);
    }
    let mut wire = json!({"model":request["model"],"input":null,"questions":[]});
    wire["input"] = Value::String(request["state"].to_string());
    wire["questions"] = Value::Array(ordered);
    Ok(wire)
}

mod response;
pub use response::normalize_response;
mod encoding;
pub use encoding::encode_request;
