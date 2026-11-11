use super::*;

fn probability(value: &Value) -> Result<f64, String> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && (0.0..=1.0).contains(n))
        .ok_or_else(|| "invalid assistance probability".into())
}

pub fn validate_answers(request: &Value, response: &Value) -> Result<(), String> {
    let questions = request["questions"]
        .as_object()
        .ok_or("missing questions")?;
    let answers = response["answers"]
        .as_object()
        .ok_or("missing assistance answers")?;
    if questions.len() != answers.len() {
        return Err("assistance answer count mismatch".into());
    }
    for (name, question) in questions {
        let answer = answers.get(name).ok_or("missing assistance answer")?;
        if answer["type"] != question["type"] {
            return Err("invalid assistance answer type".into());
        }
        match question["type"].as_str() {
            Some("noul") => {
                probability(&answer["noul"])?;
            }
            Some("score" | "choice") => {
                probability(&answer["confidence"])?;
                let probabilities = answer["probabilities"]
                    .as_object()
                    .ok_or("missing distribution")?;
                let keys: Vec<String> = if question["type"] == "score" {
                    (0..question["criteria"]
                        .as_array()
                        .ok_or("missing score levels")?
                        .len())
                        .map(|n| n.to_string())
                        .collect()
                } else {
                    question["criteria"]
                        .as_object()
                        .ok_or("missing choices")?
                        .keys()
                        .cloned()
                        .collect()
                };
                if probabilities.len() != keys.len()
                    || keys.iter().any(|k| !probabilities.contains_key(k))
                {
                    return Err("assistance distribution mismatch".into());
                }
                let values = keys
                    .iter()
                    .map(|k| probability(&probabilities[k]))
                    .collect::<Result<Vec<_>, _>>()?;
                if (values.iter().sum::<f64>() - 1.0).abs() > 0.001 {
                    return Err("invalid distribution sum".into());
                }
                if question["type"] == "score" {
                    let expected: f64 = values.iter().enumerate().map(|(i, p)| i as f64 * p).sum();
                    if !answer["score"]
                        .as_f64()
                        .is_some_and(|s| s.is_finite() && (s - expected).abs() <= 0.002)
                    {
                        return Err("inconsistent assistance score".into());
                    }
                } else {
                    let choice = answer["choice"].as_str().ok_or("invalid choice")?;
                    let p = probabilities.get(choice).ok_or("unknown choice")?;
                    if probability(p)? + 0.001 < values.iter().copied().fold(0.0, f64::max) {
                        return Err("inconsistent assistance choice".into());
                    }
                }
            }
            _ => return Err("unsupported assistance answer".into()),
        }
    }
    Ok(())
}

/// Cache reads and writes are subsets of input_tokens, never extra input.
pub fn usage(usage: Option<&Value>) -> Value {
    let mut output = json!({"input_tokens":null,"output_tokens":null,
        "cached_tokens":null,"cache_write_tokens":null});
    let Some(usage) = usage else {
        return output;
    };
    for field in ["input_tokens", "output_tokens"] {
        if let Some(n) = usage[field]
            .as_u64()
            .filter(|n| *n <= 9_007_199_254_740_991)
        {
            output[field] = json!(n);
        }
    }
    if let Some(input) = output["input_tokens"].as_u64() {
        let details = &usage["input_tokens_details"];
        let read = details["cached_tokens"].as_u64().filter(|n| *n <= input);
        let write = details["cache_write_tokens"]
            .as_u64()
            .filter(|n| *n <= input);
        if read
            .zip(write)
            .is_none_or(|(a, b)| a.saturating_add(b) <= input)
        {
            output["cached_tokens"] = json!(read);
            output["cache_write_tokens"] = json!(write);
        }
    }
    output
}
