//! Sensitive input detection and safe plain-text responses.
use super::*;

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

pub(super) fn response_text(event: &Value) -> Option<String> {
    event.get("tool_name")?.as_str()?;
    let body = event.get("tool_response")?;
    if let Some(text) = body.as_str() {
        return Some(text.to_owned());
    }
    // Local function tools serialize their model-facing content items as an
    // array. These are distinct from MCP's text blocks and metadata objects.
    if let Some(items) = body.as_array() {
        if items.is_empty() {
            return None;
        }
        let parts = items
            .iter()
            .map(|item| {
                (item.get("type")?.as_str()? == "input_text").then(|| item.get("text")?.as_str())?
            })
            .collect::<Option<Vec<_>>>()?;
        return Some(if orchestration_tool(event["tool_name"].as_str()?) {
            parts
                .into_iter()
                .map(command_preview)
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            parts.join("\n")
        });
    }
    if body.get("isError").and_then(Value::as_bool) == Some(true)
        || body.get("structuredContent").is_some()
    {
        return None;
    }
    if let Some(text) = body.get("output").and_then(Value::as_str) {
        return Some(text.to_owned());
    }
    let content = body.get("content")?.as_array()?;
    if content.is_empty() {
        return None;
    }
    let mut result = Vec::new();
    for item in content {
        if item.get("type").and_then(Value::as_str) != Some("text") {
            return None;
        }
        result.push(item.get("text")?.as_str()?);
    }
    Some(result.join("\n"))
}

pub(super) fn orchestration_tool(tool: &str) -> bool {
    matches!(tool, "exec" | "wait" | "functions.exec" | "functions.wait")
}

// Code-mode text(result) serializes command output with escaped newlines.
// Decode only the known command envelope for a readable preview. The original
// text-item array still cannot be replaced, so all metadata remains intact.
fn command_preview(text: &str) -> String {
    let Ok(Value::Object(mut object)) = serde_json::from_str::<Value>(text) else {
        return text.into();
    };
    if object.keys().any(|key| {
        ![
            "chunk_id",
            "wall_time_seconds",
            "exit_code",
            "original_token_count",
            "output",
            "session_id",
        ]
        .contains(&key.as_str())
    }) || !object.get("chunk_id").is_some_and(Value::is_string)
        || !object
            .get("wall_time_seconds")
            .is_some_and(Value::is_number)
        || !object.get("output").is_some_and(Value::is_string)
    {
        return text.into();
    }
    let output = object.remove("output").unwrap();
    format!(
        "Command result metadata: {}\n{}",
        Value::Object(object),
        output.as_str().unwrap()
    )
}
