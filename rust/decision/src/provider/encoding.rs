//! Serialize provider requests without an intermediate wire Value tree.
use super::Provider;
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Serialize, Serializer};
use serde_json::{Map, Value};
use std::borrow::Cow;
use std::fmt::Write;

pub fn encode_request(request: &Value) -> Result<Vec<u8>, String> {
    let model = request["model"].as_str().ok_or("missing model")?;
    if Provider::for_model(model)? == Provider::TypeSafe {
        return serde_json::to_vec(request).map_err(|_| "request encoding".into());
    }
    let questions = request["questions"]
        .as_object()
        .ok_or("missing questions")?;
    for question in questions.values() {
        question["instructions"]
            .as_str()
            .ok_or("invalid instructions")?;
        match question["type"].as_str() {
            Some("noul") => {}
            Some("choice") => {
                question["criteria"].as_object().ok_or("missing choices")?;
            }
            _ => return Err("unsupported decision question".into()),
        }
    }
    let wire = OpenAiRequest {
        input: request["state"].to_string(),
        model,
        questions: Questions(questions),
    };
    serde_json::to_vec(&wire).map_err(|_| "request encoding".into())
}

// Keep the canonical order of the existing JSON wire object.
#[derive(Serialize)]
struct OpenAiRequest<'a> {
    input: String,
    model: &'a str,
    questions: Questions<'a>,
}

struct Questions<'a>(&'a Map<String, Value>);

impl Serialize for Questions<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for (name, value) in self.0 {
            sequence.serialize_element(&Question { name, value })?;
        }
        sequence.end()
    }
}

struct Question<'a> {
    name: &'a str,
    value: &'a Value,
}

impl Serialize for Question<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let choice = self.value["type"] == "choice";
        let mut instructions = Cow::Borrowed(self.value["instructions"].as_str().unwrap());
        if !choice {
            if let Some(criteria) = self.value.get("criteria") {
                let text = instructions.to_mut();
                text.push_str("\nPredicate criteria: ");
                write!(text, "{criteria}").map_err(serde::ser::Error::custom)?;
            }
        }
        let mut question = serializer.serialize_map(Some(if choice { 4 } else { 3 }))?;
        if choice {
            question.serialize_entry(
                "choices",
                &Choices(self.value["criteria"].as_object().unwrap()),
            )?;
        }
        question.serialize_entry("instructions", &instructions)?;
        question.serialize_entry("name", self.name)?;
        question.serialize_entry("type", if choice { "choice" } else { "predicate" })?;
        question.end()
    }
}

struct Choices<'a>(&'a Map<String, Value>);

impl Serialize for Choices<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        #[derive(Serialize)]
        struct Choice<'a> {
            description: &'a str,
            value: &'a str,
        }
        let mut sequence = serializer.serialize_seq(Some(self.0.len()))?;
        for (value, description) in self.0 {
            sequence.serialize_element(&Choice {
                description: description.as_str().unwrap_or(""),
                value,
            })?;
        }
        sequence.end()
    }
}
