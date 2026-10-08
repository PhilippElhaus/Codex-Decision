//! Serialize provider requests without an intermediate wire Value tree.
use super::Provider;
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Serialize, Serializer};
use serde_json::{Map, Value};
use std::io::Write;

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
    encode_openai(model, &request["state"], questions).map_err(|_| "request encoding".into())
}

fn encode_openai(
    model: &str,
    state: &Value,
    questions: &Map<String, Value>,
) -> Result<Vec<u8>, serde_json::Error> {
    // Keep the canonical input/model/questions order while streaming the
    // state's JSON into its quoted input field without an intermediate String.
    let mut bytes = Vec::with_capacity(128);
    bytes.extend_from_slice(b"{\"input\":\"");
    serde_json::to_writer(&mut QuotedContent(&mut bytes), state)?;
    bytes.extend_from_slice(b"\",\"model\":");
    serde_json::to_writer(&mut bytes, model)?;
    bytes.extend_from_slice(b",\"questions\":[");
    for (index, (name, value)) in questions.iter().enumerate() {
        if index != 0 {
            bytes.push(b',');
        }
        if value["type"] == "choice" {
            serde_json::to_writer(&mut bytes, &Question { name, value })?;
        } else {
            bytes.extend_from_slice(b"{\"instructions\":");
            serde_json::to_writer(&mut bytes, value["instructions"].as_str().unwrap())?;
            if let Some(criteria) = value.get("criteria") {
                // Merge the same instruction suffix inside the serialized
                // string, preserving the exact escaping and final quote.
                bytes.pop();
                bytes.extend_from_slice(b"\\nPredicate criteria: ");
                serde_json::to_writer(&mut QuotedContent(&mut bytes), criteria)?;
                bytes.push(b'"');
            }
            bytes.extend_from_slice(b",\"name\":");
            serde_json::to_writer(&mut bytes, name)?;
            bytes.extend_from_slice(b",\"type\":\"predicate\"}");
        }
    }
    bytes.extend_from_slice(b"]}");
    Ok(bytes)
}

// Escape the serializer's JSON chunks as JSON-string content. UTF-8 bytes can
// pass unchanged; serde_json's short escapes and lowercase control escapes stay
// byte-identical to serializing the former complete intermediate String.
struct QuotedContent<'a, W>(&'a mut W);

const ESCAPE: [u8; 256] = {
    let mut escapes = [0; 256];
    let mut control = 0;
    while control < 32 {
        escapes[control] = b'u';
        control += 1;
    }
    escapes[b'\x08' as usize] = b'b';
    escapes[b'\t' as usize] = b't';
    escapes[b'\n' as usize] = b'n';
    escapes[b'\x0c' as usize] = b'f';
    escapes[b'\r' as usize] = b'r';
    escapes[b'"' as usize] = b'"';
    escapes[b'\\' as usize] = b'\\';
    escapes
};

impl<W: Write> Write for QuotedContent<'_, W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let mut start = 0;
        for (index, byte) in bytes.iter().copied().enumerate() {
            let escape = ESCAPE[byte as usize];
            if escape == 0 {
                continue;
            }
            if start != index {
                self.0.write_all(&bytes[start..index])?;
            }
            if escape == b'u' {
                let hex = b"0123456789abcdef";
                self.0.write_all(&[
                    b'\\',
                    b'u',
                    b'0',
                    b'0',
                    hex[(byte >> 4) as usize],
                    hex[(byte & 15) as usize],
                ])?;
            } else {
                self.0.write_all(&[b'\\', escape])?;
            }
            start = index + 1;
        }
        if start != bytes.len() {
            self.0.write_all(&bytes[start..])?;
        }
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

struct Question<'a> {
    name: &'a str,
    value: &'a Value,
}

impl Serialize for Question<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut question = serializer.serialize_map(Some(4))?;
        question.serialize_entry(
            "choices",
            &Choices(self.value["criteria"].as_object().unwrap()),
        )?;
        question.serialize_entry("instructions", self.value["instructions"].as_str().unwrap())?;
        question.serialize_entry("name", self.name)?;
        question.serialize_entry("type", "choice")?;
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

#[cfg(test)]
#[path = "encoding_tests.rs"]
mod tests;
