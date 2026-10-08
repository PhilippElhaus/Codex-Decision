//! Exact Lab-Control command envelopes; arbitrary structured payloads stay full.
use super::*;
use serde::ser::SerializeMap;
use serde::{Serialize, Serializer};

#[path = "lab_validation.rs"]
mod validation;
use validation::streams;

const MAX_PROJECTION: usize = 2_000_000;

pub(super) fn lab_execute(event: &Value) -> bool {
    lab_action(event["tool_name"].as_str().unwrap_or("")) == Some("lab_session_execute")
        && event
            .pointer("/tool_input/shell")
            .is_none_or(|shell| shell.is_null() || shell == "bash")
}

pub(super) fn lab_poll(tool: &str) -> bool {
    matches!(
        lab_action(tool),
        Some("lab_process_wait" | "lab_process_log_read" | "lab_process_status")
    )
}

fn lab_action(tool: &str) -> Option<&str> {
    let tool = tool.strip_prefix("functions.").unwrap_or(tool);
    let action = tool.strip_prefix("mcp__lab_control__")?;
    matches!(
        action,
        "lab_session_execute" | "lab_process_wait" | "lab_process_log_read" | "lab_process_status"
    )
    .then_some(action)
}

pub(super) fn lab_projection(body: &Value) -> Option<String> {
    lab_view(body).map(|view| view.source)
}

// This exception applies only to pinned native command contracts. The caller
// must also prove a local independent-line format before allowing replacement.
pub(super) fn supported_lab_command(event: &Value) -> bool {
    let tool = event["tool_name"].as_str().unwrap_or("");
    let execute = lab_execute(event)
        && event
            .pointer("/tool_input/script")
            .and_then(Value::as_str)
            .is_some_and(|script| !script.trim().is_empty());
    let wait = lab_action(tool) == Some("lab_process_wait");
    if !execute && !wait {
        return false;
    }
    lab_view(&event["tool_response"]).is_some_and(|view| execute || wait && view.observation)
}

pub(super) struct LabView {
    pub(super) source: String,
    pub(super) observation: bool,
    pub(super) stdout_start: usize,
    pub(super) stdout_end: usize,
    pub(super) stderr_start: usize,
    pub(super) stderr_end: usize,
}

pub(super) fn lab_view(body: &Value) -> Option<LabView> {
    let object = body.as_object()?;
    if !object.contains_key("content") {
        return payload_view(object);
    }
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
    if object
        .get("structuredContent")
        .is_some_and(|value| value != &parsed)
    {
        return None;
    }
    payload_view(parsed.as_object()?)
}

fn payload_view(payload: &serde_json::Map<String, Value>) -> Option<LabView> {
    let (stdout, stderr) = streams(payload)?;
    if stdout.len().saturating_add(stderr.len()) > MAX_PROJECTION {
        return None;
    }
    let metadata = serde_json::to_string(&LabMetadata(payload)).ok()?;
    let mut source =
        format!("Command result metadata: {metadata}\nCommand result stream: stdout\n{stdout}");
    if !source.ends_with('\n') {
        source.push('\n');
    }
    source.push_str("Command result stream: stderr\n");
    source.push_str(stderr);
    let stdout_start = 2;
    let stdout_end = stdout_start + physical_lines(stdout);
    let stderr_start = stdout_end + 1;
    let stderr_end = stderr_start + physical_lines(stderr);
    (source.len() <= MAX_PROJECTION).then_some(LabView {
        source,
        observation: payload.get("stdout").is_some_and(Value::is_object),
        stdout_start,
        stdout_end,
        stderr_start,
        stderr_end,
    })
}

fn physical_lines(text: &str) -> usize {
    text.bytes().filter(|byte| *byte == b'\n').count()
        + usize::from(!text.is_empty() && !text.ends_with('\n'))
}

struct LabMetadata<'a>(&'a serde_json::Map<String, Value>);
impl Serialize for LabMetadata<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut object = serializer.serialize_map(None)?;
        for (name, value) in self.0 {
            if name == "output" {
                continue;
            }
            if matches!(name.as_str(), "stdout" | "stderr") {
                if let Some(chunk) = value.as_object() {
                    object.serialize_entry(name, &ChunkMetadata(chunk))?;
                }
            } else {
                object.serialize_entry(name, value)?;
            }
        }
        object.end()
    }
}

struct ChunkMetadata<'a>(&'a serde_json::Map<String, Value>);
impl Serialize for ChunkMetadata<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut object = serializer.serialize_map(Some(self.0.len().saturating_sub(1)))?;
        for (name, value) in self.0 {
            if name != "text" {
                object.serialize_entry(name, value)?;
            }
        }
        object.end()
    }
}

#[cfg(test)]
#[path = "lab_result_tests.rs"]
mod tests;
