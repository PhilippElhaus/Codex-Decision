use super::*;

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
    let wire;
    let request = if request["model"] == "gpt-6-luna" {
        wire = crate::provider::wire_request(request)?;
        &wire
    } else {
        request
    };
    let state = request
        .get("state")
        .or_else(|| request.get("input"))
        .ok_or("missing request state")?;
    let questions: Vec<&Value> = if let Some(questions) = request["questions"].as_object() {
        questions.values().collect()
    } else if let Some(questions) = request["questions"].as_array() {
        questions.iter().collect()
    } else {
        return Err("missing questions".into());
    };
    if questions.is_empty() {
        return Err("empty questions".into());
    }
    let encoded_size = |value: &Value| {
        let mut size = EncodedSize::default();
        serde_json::to_writer(&mut size, value)
            .map(|()| size.0)
            .map_err(|_| "request encoding".to_owned())
    };
    let longest = questions.iter().try_fold(0, |longest, value| {
        encoded_size(value).map(|n| longest.max(n))
    })?;
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

pub fn validate_request_budget(request: &Value) -> Result<RequestBudget, String> {
    let budget = request_budget(request)?;
    if budget.state_longest_question_bound > DECISION_STATE_QUESTION_TOKENS
        || budget.whole_request_bound > DECISION_REQUEST_TOKENS
    {
        return Err("Decision context budget".into());
    }
    Ok(budget)
}
