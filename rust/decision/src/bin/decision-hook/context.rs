//! Safe task cues and plain-text response envelopes.
use super::*;
use std::borrow::Cow;

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
    .find(|value| !value.trim().is_empty() && !sensitive_context(value));
    let detail = cue
        .unwrap_or("this tool result")
        .split_whitespace()
        .take(60)
        .collect::<Vec<_>>()
        .join(" ");
    let detail = if sensitive_context(&detail) {
        "this tool result"
    } else {
        &detail
    };
    format!("Review {detail}. Keep diagnostics, exact values, unique facts, and evidence needed to understand the result.")
}

#[cfg(test)]
pub(super) fn response_text(event: &Value) -> Option<Cow<'_, str>> {
    PreparedResponse::new(event).into_source()
}

pub(super) fn project_response<'a>(
    event: &'a Value,
    projections: &ProjectionCache<'a>,
) -> Option<Cow<'a, str>> {
    event.get("tool_name")?.as_str()?;
    let body = event.get("tool_response")?;
    if let Some(text) = body.as_str() {
        return Some(Cow::Borrowed(text));
    }
    if lab_execute(event) || lab_poll(event["tool_name"].as_str()?) {
        return projections
            .direct
            .lab()
            .map(|view| Cow::Owned(view.source.clone()));
    }
    if orchestration_tool(event["tool_name"].as_str()?) {
        if let Some(view) = projections.direct.lab() {
            return Some(Cow::Owned(view.source.clone()));
        }
    }
    let tool = event["tool_name"].as_str()?;
    if body.is_object()
        && body.get("status").is_none()
        && (shell_tool(tool) || polling_tool(event) || orchestration_tool(tool))
    {
        if let Some(view) = projections.direct.command() {
            return Some(Cow::Owned(view.source.clone()));
        }
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
                projections.preview(text)
            } else {
                Cow::Borrowed(text)
            });
        }
        let parts = items
            .iter()
            .map(|item| text_block(item, "input_text"))
            .collect::<Option<Vec<_>>>()?;
        if orchestration_tool(event["tool_name"].as_str()?)
            && parts
                .iter()
                .any(|text| projections.serialized(text).projection().is_some())
            && parts.iter().any(|text| {
                text.trim_start().starts_with(['{', '['])
                    && projections.serialized(text).projection().is_none()
            })
        {
            // A valid printed command does not grant a neighboring unknown
            // JSON envelope an independent-line contract.
            return None;
        }
        return Some(Cow::Owned(
            if orchestration_tool(event["tool_name"].as_str()?) {
                parts
                    .into_iter()
                    .map(|text| projections.preview(text))
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
            Cow::Owned(projection::command_projection(body.as_object().unwrap()))
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
#[cfg(test)]
pub(super) fn replacement_supported(event: &Value) -> bool {
    PreparedResponse::new(event).replacement_supported()
}

pub(super) fn supports_replacement<'a>(
    event: &'a Value,
    projections: &ProjectionCache<'a>,
) -> bool {
    let body = &event["tool_response"];
    if body.is_string() {
        return true;
    }
    let tool = event["tool_name"].as_str().unwrap_or("");
    if lab_execute(event) || lab_poll(tool) {
        return projections.direct.lab().is_some();
    }
    if shell_tool(tool) || polling_tool(event) {
        return body.is_object()
            && body.get("status").is_none()
            && projections.direct.command().is_some();
    }
    if !orchestration_tool(tool) {
        return false;
    }
    if body.is_object() {
        return body.get("status").is_none() && projections.direct.command().is_some();
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
                projections.serialized(text).supports_text_replacement()
            })
    })
}

pub(super) fn protect_response_metadata(lines: &mut [SourceLine]) {
    let mut stream_start = None;
    let mut stderr = false;
    for index in 0..lines.len() {
        if lines[index]
            .model_text
            .starts_with("Command result stream:")
        {
            if stream_start.is_some_and(|start| index > start + 1) && !stderr {
                lines[index - 1]
                    .protected_reason
                    .get_or_insert_with(|| "stream_boundary".into());
            }
            stream_start = Some(index);
            stderr = lines[index].model_text == "Command result stream: stderr";
            lines[index].protected_reason = Some("tool_metadata".into());
        } else if lines[index]
            .model_text
            .starts_with("Command result metadata:")
            || lines[index].model_text.starts_with("Script completed")
            || lines[index]
                .model_text
                .starts_with("Script running with cell ID ")
            || lines[index].model_text.starts_with("Wall time ")
            || lines[index].model_text.starts_with("Output:")
        {
            lines[index].protected_reason = Some("tool_metadata".into());
        } else if stderr {
            lines[index]
                .protected_reason
                .get_or_insert_with(|| "stderr_output".into());
        } else if stream_start.is_some_and(|start| index == start + 1) {
            lines[index]
                .protected_reason
                .get_or_insert_with(|| "stream_boundary".into());
        }
    }
    if stream_start.is_some_and(|start| lines.len() > start + 1) && !stderr {
        lines
            .last_mut()
            .unwrap()
            .protected_reason
            .get_or_insert_with(|| "stream_boundary".into());
    }
}
