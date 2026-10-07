use super::*;

mod openai;

// Local caps based on Jev 1.13: https://docs.typesafe.ai/models
// OpenAI uses the same conservative caps, including its wire-format overhead.
pub const DECISION_STATE_QUESTION_TOKENS: usize = 32_000;
pub const DECISION_REQUEST_TOKENS: usize = 64_000;
pub const TOKEN_HEADROOM: usize = 4_096;

#[derive(Clone, Debug, serde::Serialize)]
pub struct RequestBudget {
    pub state_longest_question_bound: usize,
    pub whole_request_bound: usize,
}

// Run the exact JSON encoder without allocating encoded buffers during every
// packing probe. Escaping and UTF-8 overhead still count byte for byte.
#[derive(Default)]
struct EncodedSize(usize);

impl std::io::Write for EncodedSize {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        Ok(bytes.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

pub fn request_budget(request: &Value) -> Result<RequestBudget, String> {
    if request["model"] == "gpt-6-luna" {
        return openai::request_budget(request);
    }
    let state = request
        .get("state")
        .or_else(|| request.get("input"))
        .ok_or("missing request state")?;
    let longest = if let Some(questions) = request["questions"].as_object() {
        longest_question(questions.values())?
    } else if let Some(questions) = request["questions"].as_array() {
        longest_question(questions.iter())?
    } else {
        return Err("missing questions".into());
    };
    // No official local tokenizer is published. Count every serialized UTF-8
    // byte as a token, including JSON/question overhead, and reserve headroom
    // for the service's framing. Never assume four characters per token.
    Ok(RequestBudget {
        state_longest_question_bound: encoded_size(state)?
            .saturating_add(longest)
            .saturating_add(TOKEN_HEADROOM),
        whole_request_bound: encoded_size(request)?.saturating_add(TOKEN_HEADROOM),
    })
}

pub(super) fn encoded_size<T: serde::Serialize + ?Sized>(value: &T) -> Result<usize, String> {
    let mut size = EncodedSize::default();
    serde_json::to_writer(&mut size, value)
        .map(|()| size.0)
        .map_err(|_| "request encoding".to_owned())
}

pub(super) fn state_size<T: serde::Serialize + ?Sized>(
    model: &str,
    state: &T,
) -> Result<usize, String> {
    if model == "gpt-6-luna" {
        openai::quoted_size(state)
    } else {
        encoded_size(state)
    }
}

pub(super) fn question_sizes(
    model: &str,
    name: &str,
    question: &Value,
) -> Result<(usize, usize), String> {
    if model == "gpt-6-luna" {
        let size = openai::question_size(name, question)?;
        Ok((size, size))
    } else {
        let size = encoded_size(question)?;
        Ok((size, encoded_size(name)? + 1 + size))
    }
}

fn longest_question<'a>(questions: impl Iterator<Item = &'a Value>) -> Result<usize, String> {
    let mut longest = None;
    for question in questions {
        let length = encoded_size(question)?;
        longest = Some(longest.map_or(length, |previous: usize| previous.max(length)));
    }
    longest.ok_or_else(|| "empty questions".into())
}

pub fn validate_request_budget(request: &Value) -> Result<RequestBudget, String> {
    let budget = request_budget(request)?;
    if budget.state_longest_question_bound > DECISION_STATE_QUESTION_TOKENS
        || budget.whole_request_bound > DECISION_REQUEST_TOKENS
    {
        return Err("Decision context budget".into());
    }
    Ok(budget)
}
