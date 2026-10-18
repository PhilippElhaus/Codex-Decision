//! Validated command wrappers and atomic, homogeneous code-mode batches.
use super::projection::command_projection;
use super::*;

const MAX_PROJECTION: usize = 2_000_000;
const MAX_BATCH_ITEMS: usize = 128;

pub(super) struct CommandView {
    pub(super) source: String,
    // Zero-based first/last output lines retain each batch item's boundary.
    boundaries: Vec<(usize, usize)>,
    protected: Vec<(usize, String)>,
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

fn command_payload(body: &Value) -> Option<std::borrow::Cow<'_, Value>> {
    if known_command_result(body) {
        return Some(std::borrow::Cow::Borrowed(body));
    }
    let object = body.as_object()?;
    if !object
        .keys()
        .all(|key| matches!(key.as_str(), "content" | "structuredContent" | "isError"))
        || object.get("isError").is_some_and(|value| value != false)
    {
        return None;
    }
    let content = object.get("content")?.as_array()?;
    if content.len() != 1 {
        return None;
    }
    let block = content[0].as_object()?;
    if block.len() != 2 || block.get("type")? != "text" {
        return None;
    }
    let text = block.get("text")?.as_str()?;
    if text.len() > MAX_PROJECTION * 2 {
        return None;
    }
    let parsed = strict_json::parse(text.as_bytes()).ok()?;
    (object.get("structuredContent")? == &parsed && known_command_result(&parsed))
        .then_some(std::borrow::Cow::Owned(parsed))
}

pub(super) fn command_view(body: &Value) -> Option<CommandView> {
    if let Some(payload) = command_payload(body) {
        return Some(CommandView {
            source: command_projection(payload.as_object()?),
            boundaries: vec![],
            protected: vec![],
        });
    }
    let standalone = body.is_object() && body.get("status").is_some();
    let items = if standalone {
        std::slice::from_ref(body)
    } else {
        body.as_array()?.as_slice()
    };
    if items.is_empty() || items.len() > MAX_BATCH_ITEMS {
        return None;
    }
    // Promise.all results and fulfilled Promise.allSettled results have
    // different contracts. Never infer a contract for a mixed batch.
    let settled = items[0].get("status").is_some();
    let mut source = format!(
        "Command result metadata: {{\"batch_format\":\"{}\",\"batch_size\":{}}}\n",
        if settled { "all_settled" } else { "array" },
        items.len()
    );
    let mut line = 1;
    let mut boundaries = Vec::with_capacity(items.len());
    let mut protected = Vec::new();
    for (index, item) in items.iter().enumerate() {
        let value = if settled {
            let object = item.as_object()?;
            if !object
                .keys()
                .all(|key| matches!(key.as_str(), "i" | "status" | "value"))
                || object.get("status")? != "fulfilled"
                || object.get("i").is_some_and(|value| {
                    value
                        .as_u64()
                        .is_none_or(|i| !standalone && i != index as u64)
                })
            {
                return None;
            }
            source.push_str(&format!(
                "Command result metadata: {{\"batch_index\":{index},\"status\":\"fulfilled\""
            ));
            if let Some(i) = object.get("i") {
                source.push_str(&format!(",\"i\":{i}"));
            }
            source.push_str("}\n");
            object.get("value")?
        } else {
            if item.get("status").is_some() {
                return None;
            }
            source.push_str(&format!(
                "Command result metadata: {{\"batch_index\":{index}}}\n"
            ));
            item
        };
        let payload = command_payload(value)?;
        let projection = command_projection(payload.as_object()?);
        let output = payload["output"].as_str()?;
        let output_lines = physical_lines(output);
        if output.len() > MAX_PROJECTION || output_lines > MAX_SOURCE_LINES {
            return None;
        }
        // Flattening must not let an earlier log hide a later source object,
        // connected explanation, or unknown format. Every nonempty member
        // needs its own local independent-line contract before any API call.
        let mut member_lines = source_lines(output);
        if member_lines
            .iter()
            .any(|line| !line.model_text.trim().is_empty())
            && !matches!(
                format_decision(&json!({"tool_name":"exec"}), &mut member_lines),
                FormatDecision::Direct(_)
            )
        {
            return None;
        }
        for (index, member) in member_lines.into_iter().enumerate() {
            if let Some(reason) = member.protected_reason {
                protected.push((line + 2 + index, reason));
            }
        }
        if output_lines > 0 {
            boundaries.push((line + 2, line + 1 + output_lines));
        }
        line += 2 + output_lines;
        source.push_str(&projection);
        if !source.ends_with('\n') {
            source.push('\n');
        }
        if source.len() > MAX_PROJECTION {
            return None;
        }
    }
    Some(CommandView {
        source,
        boundaries,
        protected,
    })
}

fn physical_lines(text: &str) -> usize {
    text.bytes().filter(|byte| *byte == b'\n').count()
        + usize::from(!text.is_empty() && !text.ends_with('\n'))
}

pub(super) fn protect_command_boundaries(event: &Value, lines: &mut [SourceLine]) {
    let tool = event["tool_name"].as_str().unwrap_or("");
    if !orchestration_tool(tool) {
        return;
    }
    let Some(items) = event["tool_response"].as_array() else {
        return;
    };
    let mut offset = 0;
    for item in items {
        let Some(text) = item["text"].as_str() else {
            return;
        };
        let parsed = strict_json::parse(text.as_bytes()).ok();
        let view = parsed.as_ref().and_then(command_view);
        if let Some(view) = &view {
            for (index, reason) in &view.protected {
                if let Some(line) = lines.get_mut(offset + index) {
                    line.protected_reason.get_or_insert_with(|| reason.clone());
                }
            }
            for (first, last) in &view.boundaries {
                for index in [first, last] {
                    if let Some(line) = lines.get_mut(offset + index) {
                        line.protected_reason
                            .get_or_insert_with(|| "stream_boundary".into());
                    }
                }
            }
        }
        let preview = view
            .as_ref()
            .map(|view| std::borrow::Cow::Borrowed(view.source.as_str()))
            .unwrap_or_else(|| command_preview(text));
        // response_text joins blocks with one newline, including a blank line
        // when the preceding block already ends in a newline.
        offset += preview.bytes().filter(|byte| *byte == b'\n').count() + 1;
    }
}

#[cfg(test)]
#[path = "command_result_tests.rs"]
mod tests;
