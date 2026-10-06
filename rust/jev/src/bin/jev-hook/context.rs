//! Sensitive input detection and safe plain-text responses.
use super::*;
use std::borrow::Cow;

pub(super) fn sensitive(text: &str) -> bool {
    let lower = text.to_ascii_lowercase();
    [
        "-----begin",
        "private key",
        "api_key=",
        "api-key:",
        "access_token",
        "client_secret",
        "authorization:",
        "password=",
        "passwd=",
        "secret=",
        "token=",
        "api key",
        "bearer ",
        "sk-",
        "ghp_",
        ".env",
        "id_rsa",
        "credentials.json",
        "/.env",
        "\\.env",
    ]
    .iter()
    .any(|pattern| lower.contains(pattern))
        || [
            "password",
            "passwd",
            "api_key",
            "api-key",
            "apikey",
            "secret",
            "token",
            "authorization",
        ]
        .iter()
        .any(|name| {
            lower.match_indices(name).any(|(index, _)| {
                let rest = lower[index + name.len()..]
                    .trim_start()
                    .trim_start_matches('\\');
                let rest = rest
                    .strip_prefix('"')
                    .or_else(|| rest.strip_prefix('\''))
                    .unwrap_or(rest)
                    .trim_start();
                rest.starts_with([':', '=', '>'])
            })
        })
}

pub(super) fn sensitive_input(event: &Value) -> bool {
    event
        .get("tool_input")
        .and_then(|input| serde_json::to_string(input).ok())
        .is_some_and(|encoded| sensitive(&encoded))
}

pub(super) fn fallback_task(event: &Value) -> String {
    let input = event.get("tool_input");
    let cue = [
        "query",
        "search_query",
        "pattern",
        "q",
        "description",
        "command",
        "path",
    ]
    .iter()
    .filter_map(|name| {
        input
            .and_then(|value| value.get(*name))
            .and_then(Value::as_str)
    })
    .find(|value| !value.trim().is_empty() && !sensitive(value));
    let detail = cue
        .unwrap_or("this tool result")
        .split_whitespace()
        .take(60)
        .collect::<Vec<_>>()
        .join(" ");
    format!("Review {detail}. Keep diagnostics, exact values, unique facts, and evidence needed to understand the result.")
}

pub(super) fn response_text(event: &Value) -> Option<Cow<'_, str>> {
    event.get("tool_name")?.as_str()?;
    let body = event.get("tool_response")?;
    if let Some(text) = body.as_str() {
        return Some(Cow::Borrowed(text));
    }
    // Local function tools serialize their model-facing content items as an
    // array. These are distinct from MCP's text blocks and metadata objects.
    if let Some(items) = body.as_array() {
        if items.is_empty() {
            return None;
        }
        if items.len() == 1 {
            let text = text_block(&items[0], "input_text")?;
            return Some(if orchestration_tool(event["tool_name"].as_str()?) {
                command_preview(text)
            } else {
                Cow::Borrowed(text)
            });
        }
        let parts = items
            .iter()
            .map(|item| text_block(item, "input_text"))
            .collect::<Option<Vec<_>>>()?;
        return Some(Cow::Owned(
            if orchestration_tool(event["tool_name"].as_str()?) {
                parts
                    .into_iter()
                    .map(command_preview)
                    .collect::<Vec<_>>()
                    .join("\n")
            } else {
                parts.join("\n")
            },
        ));
    }
    if body.get("isError").and_then(Value::as_bool) == Some(true)
        || body.get("structuredContent").is_some()
    {
        return None;
    }
    if let Some(text) = body.get("output").and_then(Value::as_str) {
        return Some(if known_command_result(body) {
            Cow::Owned(command_projection(body.as_object().unwrap()))
        } else {
            Cow::Borrowed(text)
        });
    }
    let content = body.get("content")?.as_array()?;
    if content.is_empty() {
        return None;
    }
    if content.len() == 1 {
        return Some(Cow::Borrowed(text_block(&content[0], "text")?));
    }
    let mut result = Vec::new();
    for item in content {
        result.push(text_block(item, "text")?);
    }
    Some(Cow::Owned(result.join("\n")))
}

fn text_block<'a>(item: &'a Value, kind: &str) -> Option<&'a str> {
    (item.get("type")?.as_str()? == kind).then(|| item.get("text")?.as_str())?
}

pub(super) fn orchestration_tool(tool: &str) -> bool {
    matches!(tool, "exec" | "wait" | "functions.exec" | "functions.wait")
}

// Code-mode text(result) serializes command output with escaped newlines.
// Decode only the known command envelope. Metadata remains an explicit,
// protected source line, and replacement also saves the typed envelope.
fn command_preview(text: &str) -> Cow<'_, str> {
    let Ok(Value::Object(object)) = strict_json::parse(text.as_bytes()) else {
        return Cow::Borrowed(text);
    };
    if !known_command_fields(&object) {
        return Cow::Borrowed(text);
    }
    Cow::Owned(command_projection(&object))
}

fn command_projection(object: &serde_json::Map<String, Value>) -> String {
    // Metadata is small; borrow the potentially large stdout directly.
    let metadata = object
        .iter()
        .filter(|(key, _)| key.as_str() != "output")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    format!(
        "Command result metadata: {}\n{}",
        Value::Object(metadata),
        object["output"].as_str().unwrap()
    )
}

pub(super) fn known_command_result(body: &Value) -> bool {
    body.as_object().is_some_and(known_command_fields)
}

fn known_command_fields(object: &serde_json::Map<String, Value>) -> bool {
    object.get("output").is_some_and(Value::is_string)
        && object.iter().all(|(key, value)| match key.as_str() {
            "output" | "chunk_id" => value.is_string(),
            "wall_time_seconds" => value.as_f64().is_some_and(|n| n >= 0.0),
            "exit_code" => value.is_null() || value.as_i64().is_some(),
            "session_id" | "original_token_count" => value.as_u64().is_some(),
            _ => false,
        })
}

pub(super) fn replacement_supported(event: &Value) -> bool {
    let body = &event["tool_response"];
    if body.is_string() {
        return true;
    }
    let tool = event["tool_name"].as_str().unwrap_or("");
    if shell_tool(tool) {
        return known_command_result(body);
    }
    if !orchestration_tool(tool) {
        return false;
    }
    body.as_array().is_some_and(|items| {
        !items.is_empty()
            && items.iter().all(|item| {
                let Some(object) = item.as_object() else {
                    return false;
                };
                if object.len() != 2 || item["type"] != "input_text" {
                    return false;
                }
                let Some(text) = item["text"].as_str() else {
                    return false;
                };
                match strict_json::parse(text.as_bytes()) {
                    Ok(value) => known_command_result(&value),
                    Err(error) => !error.is_data(),
                }
            })
    })
}

pub(super) fn protect_response_metadata(lines: &mut [SourceLine]) {
    for line in lines {
        if line.model_text.starts_with("Command result metadata:")
            || line.model_text.starts_with("Script completed")
            || line.model_text.starts_with("Script running with cell ID ")
            || line.model_text.starts_with("Wall time ")
            || line.model_text.starts_with("Output:")
        {
            line.protected_reason = Some("tool_metadata".into());
        }
    }
}
