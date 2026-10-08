//! Strict command fields and complete, UTF-8-consistent stream chunks.
use super::*;

pub(super) fn streams(object: &serde_json::Map<String, Value>) -> Option<(&str, &str)> {
    if object.len() == 6
        && object.keys().all(|key| {
            matches!(
                key.as_str(),
                "exit_code"
                    | "stdout"
                    | "stderr"
                    | "duration_ms"
                    | "output_truncated"
                    | "writable_layer_bytes"
            )
        })
        && object["exit_code"].as_i64().is_some()
        && object["duration_ms"].as_u64().is_some()
        && object["output_truncated"] == false
        && object["writable_layer_bytes"].as_u64().is_some()
    {
        return Some((object["stdout"].as_str()?, object["stderr"].as_str()?));
    }
    if object
        .get("session_id")
        .and_then(Value::as_str)
        .is_none_or(|id| Uuid::parse_str(id).is_err())
        || object
            .get("process_id")
            .and_then(Value::as_str)
            .is_none_or(|id| Uuid::parse_str(id).is_err())
        || object.get("running").and_then(Value::as_bool).is_none()
        || object.get("exit_code").and_then(Value::as_i64).is_none()
    {
        return None;
    }
    if object.len() != 10
        || !object.keys().all(|key| {
            matches!(
                key.as_str(),
                "session_id"
                    | "process_id"
                    | "running"
                    | "exit_code"
                    | "stdout"
                    | "stderr"
                    | "terminal"
                    | "wait_timed_out"
                    | "duration_ms"
                    | "outcome_reason"
            )
        })
        || object["terminal"].as_bool().is_none()
        || object["wait_timed_out"].as_bool().is_none()
        || object["duration_ms"].as_u64().is_none()
        || object["outcome_reason"]
            .as_str()
            .is_none_or(|reason| reason.len() > 256)
    {
        return None;
    }
    Some((chunk(&object["stdout"])?, chunk(&object["stderr"])?))
}

fn chunk(value: &Value) -> Option<&str> {
    let object = value.as_object()?;
    if object.len() != 7
        || !object.keys().all(|key| {
            matches!(
                key.as_str(),
                "text"
                    | "bytes_read"
                    | "next_offset"
                    | "total_bytes"
                    | "truncated_at_start"
                    | "has_more"
                    | "reset"
            )
        })
        || ["truncated_at_start", "has_more", "reset"]
            .iter()
            .any(|key| object[*key] != false)
    {
        return None;
    }
    let read = object["bytes_read"].as_u64()?;
    let next = object["next_offset"].as_u64()?;
    let total = object["total_bytes"].as_u64()?;
    let text = object["text"].as_str()?;
    (read == text.len() as u64 && read <= next && next == total).then_some(text)
}
