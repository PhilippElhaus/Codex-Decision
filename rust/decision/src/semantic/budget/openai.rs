//! Count the existing OpenAI projection without building or cloning its values.
use super::{encoded_size, RequestBudget, TOKEN_HEADROOM};
use serde_json::Value;
use std::io::Write;

// OpenAI input contains JSON encoded inside a JSON string. Count the exact
// escaping applied to the encoder's chunks, including quotes and controls.
struct QuotedSize(usize);

impl Default for QuotedSize {
    fn default() -> Self {
        Self(2)
    }
}

impl Write for QuotedSize {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        let mut escaped = 0usize;
        let mut controls = 0usize;
        for byte in bytes {
            let short = matches!(
                byte,
                b'"' | b'\\' | b'\x08' | b'\t' | b'\n' | b'\x0c' | b'\r'
            );
            escaped += usize::from(short);
            controls += usize::from(*byte <= 31 && !short);
        }
        self.0 = self
            .0
            .saturating_add(bytes.len())
            .saturating_add(escaped)
            .saturating_add(controls.saturating_mul(5));
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

fn instructions_size(question: &Value) -> Result<usize, String> {
    let instructions = question["instructions"]
        .as_str()
        .ok_or("invalid instructions")?;
    let mut size = QuotedSize::default();
    size.write_all(instructions.as_bytes())
        .map_err(|_| "request encoding")?;
    if let Some(criteria) = question.get("criteria") {
        size.write_all(b"\nPredicate criteria: ")
            .map_err(|_| "request encoding")?;
        serde_json::to_writer(&mut size, criteria).map_err(|_| "request encoding")?;
    }
    Ok(size.0)
}

pub(super) fn question_size(name: &str, question: &Value) -> Result<usize, String> {
    let instructions = question["instructions"]
        .as_str()
        .ok_or("invalid instructions")?;
    let name_size = encoded_size(name)?;
    match question["type"].as_str() {
        Some("noul") => Ok(b"{\"instructions\":".len()
            + instructions_size(question)?
            + b",\"name\":".len()
            + name_size
            + b",\"type\":\"predicate\"}".len()),
        Some("choice") => {
            let criteria = question["criteria"].as_object().ok_or("missing choices")?;
            let mut choices = criteria.len().saturating_sub(1);
            for (value, description) in criteria {
                choices = choices.saturating_add(
                    b"{\"description\":".len()
                        + encoded_size(description.as_str().unwrap_or(""))?
                        + b",\"value\":".len()
                        + encoded_size(value)?
                        + 1,
                );
            }
            Ok(b"{\"choices\":[".len()
                + choices
                + b"],\"instructions\":".len()
                + encoded_size(instructions)?
                + b",\"name\":".len()
                + name_size
                + b",\"type\":\"choice\"}".len())
        }
        _ => Err("unsupported decision question".into()),
    }
}

pub(super) fn quoted_size<T: serde::Serialize + ?Sized>(value: &T) -> Result<usize, String> {
    let mut size = QuotedSize::default();
    serde_json::to_writer(&mut size, value).map_err(|_| "request encoding")?;
    Ok(size.0)
}

pub(super) fn request_budget(request: &Value) -> Result<RequestBudget, String> {
    let questions = request["questions"]
        .as_object()
        .ok_or("missing questions")?;
    if questions.is_empty() {
        return Err("empty questions".into());
    }
    let mut state = QuotedSize::default();
    serde_json::to_writer(&mut state, &request["state"]).map_err(|_| "request encoding")?;
    let mut longest = 0;
    let mut total_questions = questions.len() - 1;
    for (name, question) in questions {
        let length = question_size(name, question)?;
        longest = longest.max(length);
        total_questions = total_questions.saturating_add(length);
    }
    Ok(RequestBudget {
        state_longest_question_bound: state
            .0
            .saturating_add(longest)
            .saturating_add(TOKEN_HEADROOM),
        whole_request_bound: b"{\"input\":".len()
            + state.0
            + b",\"model\":".len()
            + encoded_size(&request["model"])?
            + b",\"questions\":[".len()
            + total_questions
            + b"]}".len()
            + TOKEN_HEADROOM,
    })
}
